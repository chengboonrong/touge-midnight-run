/** SFX volume, music volume and mute-all controls for the OPTIONS panel. */
import type { GameAudio } from '../audio/GameAudio';

export function addAudioControls(page: Document, panel: HTMLElement, audio: GameAudio): void {
  const label = page.createElement('label');
  const slider = page.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '5';
  slider.value = String(Math.round(audio.volume * 100));
  const describe = (): void => slider.setAttribute('aria-valuetext', `${slider.value}%`);
  describe();
  slider.addEventListener('input', () => {
    audio.setVolume(Number(slider.value) / 100);
    describe();
  });
  label.append('SFX VOLUME', slider);

  const musicLabel = page.createElement('label');
  const music = page.createElement('input');
  music.type = 'range';
  music.min = '0';
  music.max = '100';
  music.step = '5';
  music.value = String(Math.round(audio.musicVolume * 100));
  const describeMusic = (): void => music.setAttribute('aria-valuetext', `${music.value}%`);
  describeMusic();
  music.addEventListener('input', () => {
    audio.setMusicVolume(Number(music.value) / 100);
    describeMusic();
  });
  musicLabel.append('MUSIC VOLUME', music);

  const mute = page.createElement('button');
  mute.type = 'button';
  mute.textContent = 'MUTE ALL';
  mute.setAttribute('aria-pressed', String(audio.muted));
  mute.addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    mute.setAttribute('aria-pressed', String(audio.muted));
  });

  const note = page.createElement('p');
  note.className = 'options__note';
  note.textContent = 'ORIGINAL SYNTH SCORE / SYNTH SFX. TEMPORARY.';
  panel.append(label, musicLabel, mute, note);
}
