import type { EmulatorAdapter } from "./EmulatorAdapter";

/**
 * Frames the CMOS must stay unchanged before the first boot is considered
 * done. Measured on UMK3 Plus: the CMOS is written at frames 1, 6, 116 and
 * 117, so the window must be longer than the 110-frame gap in between.
 */
const STABLE_FRAMES = 180;
/** Safety cap (~11 s of game time) in case a driver never settles. */
const MAX_FRAMES = 600;

function hash(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i]!, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The cabinet's CMOS (battery-backed NVRAM) starts empty in every new core, so
 * the first boot shows "CMOS INVALID -- FACTORY SETTINGS RESTORED" and waits
 * for a button. On real hardware that happens once; the CMOS then survives
 * resets and power cycles.
 *
 * This runs that first boot off-screen (no video, audio discarded, no input)
 * until the game has written its factory CMOS, then requests a reset. The next
 * frame starts a normal boot. Because the core is deterministic, every session
 * and every peer gets the exact same CMOS.
 *
 * Returns the number of frames emulated.
 */
export function initializeCmos(emulator: EmulatorAdapter): number {
  emulator.setInput(0, 0);
  emulator.setInput(1, 0);

  let previous = hash(emulator.nvram());
  let changedOnce = false;
  let stableFor = 0;
  let frames = 0;

  while (frames < MAX_FRAMES) {
    emulator.runFrame(false);
    frames++;

    const current = hash(emulator.nvram());
    if (current !== previous) {
      changedOnce = true;
      stableFor = 0;
      previous = current;
    } else if (changedOnce && ++stableFor >= STABLE_FRAMES) {
      break;
    }
  }

  emulator.reset();
  return frames;
}

/**
 * Power-cycles the cabinet: everything returns to the boot snapshot (taken
 * right after the CMOS was set up) except the CMOS itself, which is battery
 * backed. `cmos` is the CMOS to keep: the player's current one, so settings
 * changed since the page loaded survive a restart.
 */
export function restartFromBootSnapshot(emulator: EmulatorAdapter, snapshot: Uint8Array, cmos: Uint8Array): void {
  emulator.loadState(snapshot);
  emulator.loadNvram(cmos);
  emulator.reset();
}

/** FNV-1a over 32-bit words of the full machine state (desync detection). */
export function stateHash(state: Uint8Array): number {
  const words = new Uint32Array(state.buffer, state.byteOffset, state.byteLength >>> 2);
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    h = Math.imul(h ^ words[i]!, 0x01000193);
  }
  for (let i = words.length << 2; i < state.byteLength; i++) {
    h = Math.imul(h ^ state[i]!, 0x01000193);
  }
  return h >>> 0;
}
