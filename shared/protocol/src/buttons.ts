/**
 * Logical button bits of one player, as consumed by the WASM core
 * (emulator/core/fbneo_core.cpp, enum BTN_*). Keep both in sync.
 *
 * The core binds FBNeo inputs by their "pN <name>" info string, so FIRE1..6
 * mean whatever the loaded driver assigns. For UMK3 / UMK3 Plus (Mk3InputList
 * in FBNeo's d_wunit.cpp) the assignment is documented in `Umk3Button`.
 */
export const Button = {
  Up: 1 << 0,
  Down: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Fire1: 1 << 4,
  Fire2: 1 << 5,
  Fire3: 1 << 6,
  Fire4: 1 << 7,
  Fire5: 1 << 8,
  Fire6: 1 << 9,
  Start: 1 << 10,
  Coin: 1 << 11,
} as const;

export type ButtonName = keyof typeof Button;

/** Highest valid button mask; packets carrying other bits are rejected. */
export const BUTTON_MASK = (1 << 12) - 1;

/** UMK3 cabinet labels for the generic fire buttons. */
export const Umk3Button = {
  HighPunch: Button.Fire1,
  Block: Button.Fire2,
  HighKick: Button.Fire3,
  LowPunch: Button.Fire4,
  LowKick: Button.Fire5,
  Run: Button.Fire6,
} as const;

/** Cabinet switches not bound to a player (enum SYS_* in the core). */
export const SystemSwitch = {
  Service: 1 << 0,
  Diagnostics: 1 << 1,
  Tilt: 1 << 2,
} as const;
