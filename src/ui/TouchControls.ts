/**
 * On-screen press-and-hold driving buttons for touch screens.
 *
 * Each button tracks the ids of the pointers holding it, so several fingers
 * can hold several buttons, or the same one, and a hold ends only when its
 * last pointer is released, cancelled or loses capture. Holds are reported to
 * Input as touch holds and never touch keyboard state. Window blur and the
 * page becoming hidden release everything, because the matching pointer
 * events may never arrive.
 *
 * Only a type is imported, so the Node tests can transpile this file alone.
 */
import type { HeldCode, Input } from '../core/Input';

interface Hold {
  /** The held action, or null for the one-shot reset button. */
  readonly code: HeldCode | null;
  readonly pointers: Set<number>;
}

/** Layout area (see styles.css), visible label and accessible name, action. */
const BUTTONS: ReadonlyArray<readonly [area: string, label: string, code: HeldCode | null]> = [
  ['reset', 'RESET', null],
  ['hand', 'HANDBRAKE', 'Space'],
  ['left', 'LEFT', 'KeyA'],
  ['right', 'RIGHT', 'KeyD'],
  ['brake', 'BRAKE', 'KeyS'],
  ['gas', 'GAS', 'KeyW'],
];
const RELEASE_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;

export class TouchControls {
  private readonly input: Input;
  private readonly page: Document;
  private readonly view: Window;
  private readonly root: HTMLElement;
  private readonly holds = new Map<HTMLButtonElement, Hold>();

  constructor(input: Input, page: Document, view: Window) {
    this.input = input;
    this.page = page;
    this.view = view;
    this.root = page.createElement('div');
    this.root.className = 'touch';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Touch controls');
    for (const [area, label, code] of BUTTONS) {
      const button = page.createElement('button');
      button.type = 'button';
      button.className = `touch__button touch__button--${area}`;
      button.textContent = label;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('pointerdown', this.onDown);
      for (const type of RELEASE_EVENTS) button.addEventListener(type, this.onRelease);
      this.holds.set(button, { code, pointers: new Set() });
      this.root.append(button);
    }
    this.root.addEventListener('contextmenu', this.onContextMenu);
    view.addEventListener('blur', this.releaseAll);
    page.addEventListener('visibilitychange', this.onVisibilityChange);
    page.body.append(this.root);
  }

  /** Releases every hold, detaches the listeners and removes the buttons. */
  dispose(): void {
    this.releaseAll();
    for (const button of this.holds.keys()) {
      button.removeEventListener('pointerdown', this.onDown);
      for (const type of RELEASE_EVENTS) button.removeEventListener(type, this.onRelease);
    }
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    this.view.removeEventListener('blur', this.releaseAll);
    this.page.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.root.remove();
  }

  /** Releases every hold, including the tracked pointers and aria-pressed. */
  clear(): void {
    this.releaseAll();
  }

  /** Disables or enables the buttons, for example while a menu is open. */
  setDisabled(disabled: boolean): void {
    this.releaseAll();
    for (const button of this.holds.keys()) button.disabled = disabled;
  }

  private setPressed(button: HTMLButtonElement, hold: Hold, pressed: boolean): void {
    button.setAttribute('aria-pressed', String(pressed));
    if (hold.code) this.input.setTouchHeld(hold.code, pressed);
    else if (pressed) this.input.requestReset();
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (event.button !== 0) return; // touch, pen and the primary mouse button only
    event.preventDefault(); // no focus change, selection or compatibility mouse events
    const button = event.currentTarget as HTMLButtonElement;
    if (button.disabled) return;
    const hold = this.holds.get(button)!;
    const first = hold.pointers.size === 0;
    button.setPointerCapture(event.pointerId);
    hold.pointers.add(event.pointerId);
    if (first) this.setPressed(button, hold, true);
  };

  private readonly onRelease = (event: PointerEvent): void => {
    const button = event.currentTarget as HTMLButtonElement;
    const hold = this.holds.get(button)!;
    if (hold.pointers.delete(event.pointerId) && hold.pointers.size === 0) {
      this.setPressed(button, hold, false);
    }
  };

  private readonly releaseAll = (): void => {
    for (const [button, hold] of this.holds) {
      if (hold.pointers.size === 0) continue;
      hold.pointers.clear();
      this.setPressed(button, hold, false);
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (this.page.visibilityState === 'hidden') this.releaseAll();
  };

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };
}
