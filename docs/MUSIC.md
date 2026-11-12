# Music: temporary original synth score

Status: TEMPORARY synthesized score. It is not a production recording and not the work of a professional composer.

## Source and licensing

- Generator: `tools/audio/build_music.py` (Python 3 standard library only, deterministic).
- The original notes, arrangement and synthesis are defined in that script with Claude API assistance. No samples, no recordings, no external downloads, no melodies copied from any existing work. The style is Eurobeat-inspired only.
- License: the script and the audio it generates are CC0 1.0.
- Outputs in `public/assets/audio/`: `menu.mp3`, `prepare.mp3`, `race.mp3`, `results.mp3`, `manifest.json`.
- Rebuild: `python3 tools/audio/build_music.py`. It needs ffmpeg on PATH or at `/opt/homebrew/bin/ffmpeg`. WAV exists only in a temp directory during encoding.

## Spec

All tracks: 156 BPM, E minor, 44.1 kHz mono, MP3 160 kbps CBR, peak about -2.7 dBFS before encoding (tanh soft limiter).

| State | File | Bars | Source length (s) | Loop start..end (source samples) |
|---|---|---|---|---|
| menu | menu.mp3 | 16 | 24.615 | 0..1085538 |
| prepare | prepare.mp3 | 8 | 12.308 | 0..542769 |
| race | race.mp3 | 32 | 49.231 | 0..2171077 |
| results | results.mp3 | 8 | 12.308 | 0..542769 |

`manifest.json` is written by the script and holds the values it actually produced; treat it as authoritative over this table.

Race arrangement: intro 4 bars (kick, hats, bass, pad), verse 8 (adds snare on 2 and 4 and the arp), chorus 8 (4-bar lead motif, then its variation), breakdown 4 (pad and arp, snare-roll build), drop 8 (full).

Loop continuity: note tails that pass the end are mixed back into the start, so the PCM loops without a discontinuity. MP3 adds encoder delay and padding, and the runtime loops with `HTMLMediaElement.loop`, so a short gap at the loop point is possible.

## Runtime

- `src/audio/musicState.ts`: pure states, URLs, preferences and two-slot crossfade planning (tested in `test/music.test.mjs`).
- `src/audio/MusicManager.ts`: two media elements, two MediaElementAudioSourceNodes and two GainNodes on GameAudio's compressor bus; 0.8 s crossfade; built once inside the existing unlock gesture.
- `GameAudio.setMusicState('menu' | 'prepare' | 'race' | 'results')`. The default is `race` (free practice). A state set before unlock is stored and used at unlock.
- Preferences live in `localStorage['touge.audio']`: `volume` (SFX), `muted` (mute all), `musicVolume` (default 0.25). Older data without `musicVolume` keeps its SFX volume and mute.
- Music gain is `0.6 * musicVolume`, independent of the SFX master, and zero when muted. While paused or hidden both music gains are zero and both elements are paused.

## Replacement requirements

A replacement track must keep the file name for its state, loop cleanly from its first to its last sample, peak at or below -1 dBFS, be an MP3 (or have its URL updated in `MUSIC_TRACKS`), be original or properly licensed with the license recorded here, and have `manifest.json` and this file updated to match.
