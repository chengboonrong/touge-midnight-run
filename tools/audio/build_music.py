#!/usr/bin/env python3
# Builds the TEMPORARY original synth score for TOUGE. Python 3 stdlib only, deterministic.
# The original notes, arrangement and synthesis are defined in this script with Claude API assistance: no samples,
# no recordings, no third-party melodies. License: this code and the audio it generates are
# released under CC0 1.0 (public domain dedication).
# Usage: python3 tools/audio/build_music.py   (needs ffmpeg on PATH or in /opt/homebrew/bin)
# Writes public/assets/audio/{menu,prepare,race,results}.mp3 and manifest.json. WAV is temp only.
import array, json, math, os, random, shutil, subprocess, sys, tempfile, wave

SR, BPM, KBPS = 44100, 156, 160
STEP = 60 / BPM / 4
BAR = STEP * 16
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'public', 'assets', 'audio')
RNG = random.Random(156)
CACHE = {}

# E minor. Chord: (bass root MIDI, pad/arp triad MIDI).
CHORDS = {'Em': (40, (64, 67, 71)), 'C': (36, (60, 64, 67)), 'D': (38, (62, 66, 69)), 'Bm': (35, (59, 62, 66))}
V, CH = ['Em', 'C', 'D', 'Em'], ['C', 'D', 'Bm', 'Em']
# Syncopated bass: (16th step, semitone offset from the root).
BASS = [(0, 0), (2, 0), (3, 12), (6, 0), (7, 12), (8, 0), (10, 0), (11, 12), (13, 0), (14, 12), (15, 0)]
ARP = [0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1, 2, 1, 0, 2]
# Original 4-bar lead motif over C D Bm Em: (16th step, MIDI note, length in steps).
M = [
    [(0, 76, 3), (3, 79, 3), (6, 83, 2), (8, 81, 4), (12, 79, 2), (14, 76, 2)],
    [(0, 78, 3), (3, 81, 3), (6, 86, 2), (8, 81, 4), (12, 78, 2), (14, 81, 2)],
    [(0, 78, 3), (3, 74, 3), (6, 78, 2), (8, 83, 4), (12, 81, 2), (14, 78, 2)],
    [(0, 79, 6), (6, 76, 2), (8, 83, 6), (14, 81, 1), (15, 79, 1)],
]
MOTIF = M + M[:3] + [[(0, 79, 3), (3, 83, 3), (6, 88, 6), (12, 86, 2), (14, 83, 2)]]
# Per bar layers: K kick, S snare, H hats, B bass, P pad, A arp, L lead, R snare-roll build.
FULL = 'KSHBPAL'
TRACKS = {
    'menu': (['PA'] * 4 + ['KHPA'] * 4 + ['KHBPA'] * 4 + ['KHBPAL'] * 4, V * 2 + CH * 2),
    'prepare': (['HBP'] * 4 + ['KHBP'] * 2 + ['KHBPA', 'KHBPAR'], ['Em'] * 4 + ['C', 'C', 'D', 'D']),
    # intro 4, verse 8, chorus 8, breakdown 4, drop 8
    'race': (['KHBP'] * 4 + ['KSHBPA'] * 8 + [FULL] * 8 + ['PA'] * 3 + ['PAR'] + [FULL] * 8,
             V * 3 + CH * 2 + ['C', 'D', 'Em', 'D'] + CH * 2),
    'results': (['PAL'] * 4 + [FULL] * 4, CH * 2),
}


def voice(m, steps, cut, att, rel, dec, det=0.0, sq=False):
    # Two detuned saws (or one square) through a one-pole low-pass, with linear attack/release.
    key = (m, steps, cut, att, rel, dec, det, sq)
    if key not in CACHE:
        a, r = int(att * SR), int(rel * SR)
        n = int(steps * STEP * SR) + r
        out = array.array('f', bytes(4 * n))
        f = 440 * 2 ** ((m - 69) / 12)
        d1, d2, p1, p2, lp, g = f / SR, f * (1 + det) / SR, 0.0, 0.5, 0.0, 1.0
        k, dg = 1 - math.exp(-2 * math.pi * cut / SR), math.exp(-dec / SR)
        for i in range(n):
            p1 = (p1 + d1) % 1.0
            p2 = (p2 + d2) % 1.0
            lp += k * (((1.0 if p1 < 0.5 else -1.0) if sq else p1 + p2 - 1.0) - lp)
            out[i] = lp * g * min(1.0, i / a, (n - i) / r)
            g *= dg
        CACHE[key] = out
    return CACHE[key]


def drum(kind):
    # Soft percussion: 1.4 ms attack ramp and a faded tail, so no clicks.
    if kind not in CACHE:
        dur, dec = {'kick': (0.24, 0.07), 'snare': (0.2, 0.05), 'hat': (0.05, 0.012), 'open': (0.16, 0.05)}[kind]
        n = int(dur * SR)
        out = array.array('f', bytes(4 * n))
        ph = lp = 0.0
        for i in range(n):
            env = math.exp(-i / (dec * SR)) * min(1.0, i / 60, (n - i) / 400)
            if kind == 'kick':
                ph += 2 * math.pi * (46 + 120 * math.exp(-i / (0.025 * SR))) / SR
                x = math.sin(ph)
            else:
                w = RNG.uniform(-1, 1)
                lp += (0.5 if kind == 'snare' else 0.25) * (w - lp)
                x = 0.7 * lp + 0.5 * math.sin(2 * math.pi * 185 * i / SR) if kind == 'snare' else w - lp
            out[i] = x * env
        CACHE[kind] = out
    return CACHE[kind]


def add(buf, t, clip, gain):
    # Tails wrap to the start, so the last sample flows into the first when looped.
    n = len(buf)
    j = int(round(t * SR)) % n
    for v in clip:
        buf[j] += v * gain
        j += 1
        if j == n:
            j = 0


def render(bars, chords):
    assert len(bars) == len(chords)
    n = int(round(len(bars) * BAR * SR))
    buf = array.array('f', bytes(4 * n))
    lead = 0
    for b, (lay, ch) in enumerate(zip(bars, chords)):
        root, triad = CHORDS[ch]
        t0 = b * BAR
        for s in range(16):
            t = t0 + s * STEP
            if 'K' in lay and s % 4 == 0:
                add(buf, t, drum('kick'), 0.9)
            if 'S' in lay and s % 8 == 4:
                add(buf, t, drum('snare'), 0.5)
            if 'H' in lay:
                add(buf, t, drum('open' if s == 14 and b % 4 == 3 else 'hat'), 0.17 if s % 4 == 2 else 0.07)
            if 'R' in lay:
                add(buf, t, drum('snare'), 0.12 + 0.025 * s)
            if 'A' in lay:
                add(buf, t, voice(triad[ARP[s]] + 12, 1, 3500, 0.003, 0.02, 9, sq=True), 0.11)
        if 'B' in lay:
            for s, o in BASS:
                add(buf, t0 + s * STEP, voice(root + o, 1, 700, 0.004, 0.02, 6), 0.5)
        if 'P' in lay:
            for m in triad:
                add(buf, t0, voice(m, 17, 1400, 0.12, 0.25, 0.3, det=0.006), 0.09)
        if 'L' in lay:
            for s, m, length in MOTIF[lead % 8]:
                add(buf, t0 + s * STEP, voice(m, length, 4200, 0.006, 0.04, 2.5, det=0.007), 0.3)
            lead += 1
    # Soft limiter: tanh saturation, output peak about -2.7 dBFS to leave room for MP3 overshoot.
    g = 1.5 / (max(max(buf), -min(buf)) or 1.0)
    return array.array('h', (int(26500 * math.tanh(v * g)) for v in buf))


def main():
    brew = '/opt/homebrew/bin/ffmpeg'
    ffmpeg = shutil.which('ffmpeg') or (brew if os.path.isfile(brew) else None)
    if not ffmpeg:
        sys.exit('ffmpeg not found: install it or add it to PATH, then run again.')
    os.makedirs(OUT, exist_ok=True)
    tracks = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, (bars, chords) in TRACKS.items():
            pcm = render(bars, chords)
            samples = len(pcm)
            if sys.byteorder == 'big':
                pcm.byteswap()
            wav = os.path.join(tmp, name + '.wav')
            with wave.open(wav, 'wb') as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SR)
                w.writeframes(pcm.tobytes())
            subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame',
                            '-b:a', '%dk' % KBPS, os.path.join(OUT, name + '.mp3')], check=True)
            tracks.append({'state': name, 'file': name + '.mp3', 'bars': len(bars), 'loopStartSample': 0,
                           'loopEndSample': samples, 'durationSeconds': round(samples / SR, 4)})
            print('%s: %d bars, %.3f s' % (name, len(bars), samples / SR))
    manifest = {'title': 'TOUGE temporary original synth score', 'bpm': BPM, 'key': 'E minor', 'sampleRate': SR,
                'channels': 1, 'codec': 'mp3', 'bitrateKbps': KBPS, 'license': 'CC0-1.0',
                'attribution': 'Generated by tools/audio/build_music.py (original notes and synthesis, no samples).',
                'note': 'Loop endpoints are source PCM samples; MP3 encoding adds padding.', 'tracks': tracks}
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()
