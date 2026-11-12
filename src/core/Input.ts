/**
 * Keyboard input, plus holds reported by the on-screen touch controls.
 *
 * - W / A / S / D / Space are tracked as held state.
 * - R raises a one-shot reset request. Auto-repeat keydowns never raise one, so
 *   holding R resets once. The request stays pending until consumeReset().
 * - Handled keys have their browser default prevented (Space would scroll).
 * - Combinations with Ctrl, Cmd or Alt are left alone, so browser shortcuts
 *   such as Ctrl/Cmd+R keep working and do not register as game input.
 * - Losing focus clears held keys and any pending reset, because the matching
 *   keyup events are never delivered to an unfocused window.
 * - Touch holds are kept apart from keyboard holds: an action is held while
 *   either source holds it, and each source only ever releases its own hold.
 *   The touch controls own the touch lifecycle, including on blur.
 *
 * Keys are matched by KeyboardEvent.code (physical position), so the layout
 * stays WASD-shaped on non-QWERTY keyboards.
 *
 * This file has no imports on purpose: the Node tests transpile it standalone.
 */

export type HeldCode = 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD' | 'Space';

/** The part of EventTarget that Input needs. `window` satisfies it. */
export type InputEventTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

const HELD_CODES: ReadonlySet<string> = new Set<HeldCode>([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
]);
const RESET_CODE = 'KeyR';

function isHeldCode(code: string): code is HeldCode {
  return HELD_CODES.has(code);
}

function hasShortcutModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

export class Input {
  private readonly target: InputEventTarget;
  private readonly held = new Set<HeldCode>();
  private readonly touchHeld = new Set<HeldCode>();
  private resetPending = false;

  constructor(target: InputEventTarget) {
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  isHeld(code: HeldCode): boolean {
    return this.held.has(code) || this.touchHeld.has(code);
  }

  /** Sets the touch hold of an action without affecting its keyboard hold. */
  setTouchHeld(code: HeldCode, held: boolean): void {
    if (held) this.touchHeld.add(code);
    else this.touchHeld.delete(code);
  }

  /** Raises the same one-shot reset request as R. */
  requestReset(): void {
    this.resetPending = true;
  }

  /** Returns true at most once per reset request, then clears it. */
  consumeReset(): boolean {
    const pending = this.resetPending;
    this.resetPending = false;
    return pending;
  }

  /** Detaches the listeners and drops all state. */
  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.clear();
    this.touchHeld.clear();
  }

  private clear(): void {
    this.held.clear();
    this.resetPending = false;
  }

  private readonly onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    if (hasShortcutModifier(e)) {
      this.clear(); // A browser shortcut may prevent the matching keyup.
      return;
    }

    if (isHeldCode(e.code)) {
      this.held.add(e.code);
    } else if (e.code === RESET_CODE) {
      if (!e.repeat) this.resetPending = true;
    } else {
      return;
    }
    e.preventDefault();
  };

  private readonly onKeyUp = (event: Event): void => {
    const e = event as KeyboardEvent;

    // Always release, even with a modifier down, so a key can never stick.
    if (isHeldCode(e.code)) {
      this.held.delete(e.code);
    } else if (e.code !== RESET_CODE) {
      return;
    }
    if (!hasShortcutModifier(e)) e.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.clear();
  };
}
