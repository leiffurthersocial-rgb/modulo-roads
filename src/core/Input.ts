/**
 * Keyboard (and virtual touch button) input mapped to rebindable actions.
 *
 * Designed for iPad Safari with a hardware keyboard:
 *  - uses KeyboardEvent.code so bindings survive keyboard layouts (QWERTZ!)
 *  - prevents default on every bound key so arrows/space/tab never scroll
 *    the page or move focus
 *  - maps Cmd+. (the iPad "escape" chord) to Escape, since the Magic
 *    Keyboard has no Escape key
 *  - clears held keys on blur/visibility change so the car never gets stuck
 *    accelerating after an app switch.
 */
import type { Action } from './Settings';
import { getSettings } from './Settings';

type ActionListener = (action: Action, e: KeyboardEvent | null) => void;

export class Input {
  private held = new Set<string>();
  private virtual = new Set<Action>();
  private codeToActions = new Map<string, Action[]>();
  private listeners: ActionListener[] = [];
  private capture: ((code: string) => void) | null = null;
  /** performance.now() of the last real user input – drives HUD auto-hide. */
  lastInputTime = performance.now();
  /** True once any hardware key was seen; used to auto-hide touch controls. */
  keyboardSeen = false;

  constructor() {
    this.rebuildMap();
    getSettings().onChange((section, key) => {
      if (section === 'controls' && key === 'bindings') this.rebuildMap();
    });
    getSettings().events.on('reset', () => this.rebuildMap());
    window.addEventListener('keydown', this.onDown, { passive: false });
    window.addEventListener('keyup', this.onUp, { passive: false });
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
    const mark = () => (this.lastInputTime = performance.now());
    window.addEventListener('pointerdown', mark, { passive: true });
    window.addEventListener('pointermove', mark, { passive: true });
  }

  rebuildMap(): void {
    this.codeToActions.clear();
    const b = getSettings().data.controls.bindings;
    for (const action of Object.keys(b) as Action[]) {
      for (const code of b[action]) {
        if (!code) continue;
        const list = this.codeToActions.get(code) ?? [];
        list.push(action);
        this.codeToActions.set(code, list);
      }
    }
  }

  /** Subscribe to discrete action presses (fires once per key press, not on repeat). */
  onAction(fn: ActionListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Grab the next key press (for rebinding). Escape cancels with code ''. */
  captureNext(cb: (code: string) => void): void {
    this.capture = cb;
  }
  cancelCapture(): void {
    this.capture = null;
  }

  isDown(action: Action): boolean {
    if (this.virtual.has(action)) return true;
    const codes = getSettings().data.controls.bindings[action];
    for (let i = 0; i < codes.length; i++) if (this.held.has(codes[i])) return true;
    return false;
  }

  /** Touch controls set actions directly. */
  setVirtual(action: Action, on: boolean): void {
    const was = this.virtual.has(action);
    if (on) this.virtual.add(action);
    else this.virtual.delete(action);
    this.lastInputTime = performance.now();
    if (on && !was) this.fire(action, null);
  }

  clear(): void {
    this.held.clear();
    this.virtual.clear();
  }

  /** Any driving key held? (for HUD idle detection) */
  anyDriving(): boolean {
    return (
      this.isDown('accelerate') || this.isDown('brake') || this.isDown('left') || this.isDown('right') || this.isDown('handbrake')
    );
  }

  private fire(action: Action, e: KeyboardEvent | null): void {
    for (const l of this.listeners) l(action, e);
  }

  private static normalise(e: KeyboardEvent): string {
    // iPad: Cmd+. is the system "escape" shortcut.
    if (e.metaKey && (e.key === '.' || e.code === 'Period')) return 'Escape';
    if (e.code) return e.code;
    // Very old browsers: derive something stable from key.
    if (e.key === ' ') return 'Space';
    if (e.key.length === 1) return 'Key' + e.key.toUpperCase();
    return e.key;
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = t.tagName;
    return (tag === 'INPUT' && (t as HTMLInputElement).type === 'text') || tag === 'TEXTAREA' || t.isContentEditable;
  }

  private onDown = (e: KeyboardEvent): void => {
    const code = Input.normalise(e);
    this.keyboardSeen = true;
    this.lastInputTime = performance.now();
    if (this.capture) {
      e.preventDefault();
      const cb = this.capture;
      this.capture = null;
      cb(code === 'Escape' ? '' : code);
      return;
    }
    if (this.isTyping(e)) {
      if (code === 'Escape' || code === 'Enter') (e.target as HTMLElement).blur();
      return;
    }
    // Let system shortcuts (Cmd+R, Cmd+Tab, Ctrl+L…) through.
    if ((e.metaKey || e.ctrlKey) && code !== 'Escape') return;
    const actions = this.codeToActions.get(code);
    if (actions) {
      e.preventDefault();
      if (!e.repeat && !this.held.has(code)) {
        this.held.add(code);
        for (const a of actions) this.fire(a, e);
      }
      this.held.add(code);
    } else if (code === 'Space' || code.startsWith('Arrow') || code === 'Tab') {
      e.preventDefault();
    }
  };

  private onUp = (e: KeyboardEvent): void => {
    const code = Input.normalise(e);
    this.held.delete(code);
    // Safari drops keyup for keys released while Cmd is held – be safe.
    if (e.key === 'Meta') this.held.clear();
    if (this.codeToActions.has(code)) e.preventDefault();
  };
}

/** Human friendly label for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    ShiftLeft: 'Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'Ctrl',
    AltLeft: 'Alt',
    Escape: 'Esc',
    Backquote: '`',
    Slash: '?',
    Tab: 'Tab',
    Enter: 'Enter',
    Backspace: '⌫',
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backslash: '\\',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
