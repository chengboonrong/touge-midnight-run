/**
 * Title/start menu over the live scene: plain DOM, shown at boot, never auto-focused
 * (a focused button would swallow the first W). One delegated click listener on the root.
 *
 * This file has no imports on purpose: the Node test transpiles it standalone.
 */

/** Route length in metres as a short label, or '' when unusable. */
export function formatLength(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} KM` : `${Math.round(meters)} M`;
}

/** Best lap in seconds as 'PB m:ss.mmm', or '' when there is none. */
export function formatBest(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const ms = Math.round(seconds * 1000);
  return `PB ${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

export class StartMenu {
  readonly root: HTMLElement;
  private readonly page: Document;
  private readonly best: HTMLElement;
  private readonly onTimeAttack: () => void;
  private readonly onPractice: () => void;

  constructor(page: Document, routeLength: number, best: number | null, onTimeAttack: () => void, onPractice: () => void) {
    this.page = page;
    this.onTimeAttack = onTimeAttack;
    this.onPractice = onPractice;
    const el = (tag: string, className: string, text = ''): HTMLElement => {
      const node = page.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const button = (action: string, text: string): HTMLElement => {
      const node = el('button', '', text);
      node.setAttribute('type', 'button');
      node.dataset.action = action;
      return node;
    };
    this.root = el('section', 'start-menu');
    this.root.setAttribute('aria-label', 'Title screen');
    const title = el('h1', 'start-menu__title');
    title.append(el('span', '', 'TOUGE'), el('span', '', 'MIDNIGHT RUN'));
    const length = formatLength(routeLength);
    this.best = el('p', 'start-menu__best');
    const actions = el('div', 'start-menu__actions');
    actions.append(button('attack', 'TIME ATTACK'), button('practice', 'FREE PRACTICE'));
    this.root.append(title, el('p', 'start-menu__course', length ? `KUROTAKE PASS / ${length}` : 'KUROTAKE PASS'), this.best, actions,
      el('p', 'start-menu__keys', 'W A S D DRIVE / SPACE HANDBRAKE / R RESET'));
    this.root.addEventListener('click', this.onClick);
    page.body.append(this.root);
    this.show(best);
  }

  /** Shows the menu with the current best lap (seconds), if any. */
  show(best: number | null): void {
    const text = formatBest(best);
    this.best.textContent = text;
    this.best.hidden = !text;
    this.root.hidden = false;
  }

  /** Hides the menu and gives the keyboard back to the game. */
  hide(): void {
    this.root.hidden = true;
    const active = this.page.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
  }

  private readonly onClick = (event: Event): void => {
    const action = (event.target as Element | null)?.closest?.('[data-action]')?.getAttribute('data-action');
    if (action === 'attack') this.onTimeAttack();
    else if (action === 'practice') this.onPractice();
  };
}
