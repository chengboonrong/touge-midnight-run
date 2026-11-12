/**
 * The OPTIONS menu: one native details element with a graphics quality select.
 * `root` and `panel` are public so later controls (audio) can be appended.
 */
import type { Quality } from '../render/SceneSetup';

const STORAGE_KEY = 'touge.quality';

export function parseQuality(value: unknown): Quality {
  return value === 'low' ? 'low' : 'high';
}

/** The saved quality, or High when storage is missing, invalid or throws. */
export function loadQuality(): Quality {
  try {
    return parseQuality(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'high';
  }
}

export class Options {
  readonly root: HTMLDetailsElement;
  readonly panel: HTMLDivElement;

  constructor(page: Document, quality: Quality, setQuality: (quality: Quality) => void, onToggle: (open: boolean) => void) {
    this.root = page.createElement('details');
    this.root.className = 'options';
    const summary = page.createElement('summary');
    summary.textContent = 'OPTIONS';
    this.panel = page.createElement('div');
    this.panel.className = 'options__panel';
    const label = page.createElement('label');
    const select = page.createElement('select');
    for (const value of ['high', 'low'] as const) {
      const option = page.createElement('option');
      option.value = value;
      option.textContent = value.toUpperCase();
      select.append(option);
    }
    select.value = quality;
    select.addEventListener('change', () => {
      const next = parseQuality(select.value);
      setQuality(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage is unavailable; the choice lasts for this session only.
      }
    });
    label.append('GRAPHICS', select);
    this.panel.append(label);
    this.root.append(summary, this.panel);
    this.root.addEventListener('toggle', () => {
      const active = page.activeElement;
      // On close, give the keyboard back to the game without a canvas click.
      if (!this.root.open && active instanceof HTMLElement && this.root.contains(active)) active.blur();
      onToggle(this.root.open);
    });
    page.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.root.open) this.root.open = false;
    });
    page.body.append(this.root);
  }

  get isOpen(): boolean {
    return this.root.open;
  }
}
