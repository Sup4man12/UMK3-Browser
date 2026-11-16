import { Button, type ButtonName } from "@umk3/protocol";

/** KeyboardEvent.code per logical button of the local player. */
export type KeyBindings = Partial<Record<ButtonName, string>>;

/**
 * Keys the game never receives. Enter is the online "ready / restart" key
 * (see NetplayClient), F2 the cabinet's test button and Escape cancels a rebind.
 */
export const RESERVED_KEYS = new Set(["Enter", "NumpadEnter", "Escape", "F2"]);

/**
 * UMK3 cabinet layout: punches/kicks on two rows, block and run in the middle.
 * Every player uses this same layout on their own keyboard, whether they are
 * Player 1 or Player 2 online.
 */
export const DEFAULT_BINDINGS: KeyBindings = {
  Up: "KeyW", Down: "KeyS", Left: "KeyA", Right: "KeyD",
  Fire1: "KeyU", Fire2: "KeyO", Fire3: "KeyI",
  Fire4: "KeyJ", Fire6: "KeyL", Fire5: "KeyK",
  Start: "Digit1", Coin: "Digit5",
};

export type InputListener = (buttons: number) => void;

/**
 * Translates keyboard state into the local player's button mask and reports
 * only changes. Uses KeyboardEvent.code (physical key), so layouts such as
 * AZERTY or ABNT2 keep the same positions.
 */
export class InputManager {
  private lookup = new Map<string, number>();
  private readonly pressed = new Set<string>();
  private state = 0;
  private target: Window | null = null;

  constructor(
    bindings: KeyBindings,
    private readonly listener: InputListener,
  ) {
    this.setBindings(bindings);
  }

  setBindings(bindings: KeyBindings): void {
    this.releaseAll();
    this.lookup = new Map();
    for (const [name, code] of Object.entries(bindings) as [ButtonName, string][]) {
      if (!RESERVED_KEYS.has(code)) {
        this.lookup.set(code, Button[name]);
      }
    }
  }

  /** Returns true when the key is bound (the caller should preventDefault). */
  handleKey(code: string, down: boolean): boolean {
    if (!this.lookup.has(code)) {
      return false;
    }
    if (down) {
      this.pressed.add(code);
    } else {
      this.pressed.delete(code);
    }
    this.recompute();
    return true;
  }

  releaseAll(): void {
    this.pressed.clear();
    this.recompute();
  }

  attach(target: Window): void {
    this.detach();
    this.target = target;
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    if (!this.target) {
      return;
    }
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
    this.target.removeEventListener("blur", this.onBlur);
    this.target = null;
    this.releaseAll();
  }

  private recompute(): void {
    let buttons = 0;
    for (const code of this.pressed) {
      buttons |= this.lookup.get(code) ?? 0;
    }
    if (buttons !== this.state) {
      this.state = buttons;
      this.listener(buttons);
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isEditable(event.target)) {
      return;
    }
    if (this.handleKey(event.code, true)) {
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (this.handleKey(event.code, false)) {
      event.preventDefault();
    }
  };

  // Keys released while the window is unfocused never fire keyup.
  private readonly onBlur = () => this.releaseAll();
}

export function isEditable(target: EventTarget | null): boolean {
  return (
    typeof HTMLElement !== "undefined" &&
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Binds `code` to one button, removing it from any other button. Reserved keys are refused. */
export function rebind(bindings: KeyBindings, name: ButtonName, code: string): KeyBindings {
  if (RESERVED_KEYS.has(code)) {
    return bindings;
  }
  const next: KeyBindings = { ...bindings };
  for (const [other, otherCode] of Object.entries(next) as [ButtonName, string][]) {
    if (otherCode === code) {
      delete next[other];
    }
  }
  next[name] = code;
  return next;
}
