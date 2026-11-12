/** SFX volume and mute controls for the OPTIONS panel. There is no music, so no music controls. */
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

  const mute = page.createElement('button');
  mute.type = 'button';
  mute.textContent = 'MUTE SFX';
  mute.setAttribute('aria-pressed', String(audio.muted));
  mute.addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    mute.setAttribute('aria-pressed', String(audio.muted));
  });

  const note = page.createElement('p');
  note.className = 'options__note';
  note.textContent = 'PLACEHOLDER SYNTH SFX. NO MUSIC YET.';
  panel.append(label, mute, note);
}
