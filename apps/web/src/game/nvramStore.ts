/**
 * The player's own CMOS (battery-backed NVRAM: UMK3+ settings, audits, high
 * scores), kept in this browser's localStorage. It never leaves the machine:
 * unlike cookies, localStorage is not sent with HTTP requests, and a 32 KiB
 * NVRAM does not fit a 4 KiB cookie anyway.
 */

const KEY_PREFIX = "umk3.nvram.v1.";

/** Minimal Storage surface (lets tests inject a fake; localStorage may also be blocked). */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // e.g. storage disabled by privacy settings
  }
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    data[i] = binary.charCodeAt(i);
  }
  return data;
}

export class NvramStore {
  constructor(private readonly storage: KeyValueStorage | null = defaultStorage()) {}

  get available(): boolean {
    return this.storage !== null;
  }

  /** The saved CMOS for a driver, or null when there is none (or it is unreadable). */
  load(driver: string): Uint8Array | null {
    try {
      const raw = this.storage?.getItem(KEY_PREFIX + driver);
      return raw ? fromBase64(raw) : null;
    } catch {
      return null;
    }
  }

  /** Returns false when the browser refused to store it (quota, private mode...). */
  save(driver: string, data: Uint8Array): boolean {
    try {
      this.storage?.setItem(KEY_PREFIX + driver, toBase64(data));
      return this.storage !== null;
    } catch {
      return false;
    }
  }

  clear(driver: string): void {
    try {
      this.storage?.removeItem(KEY_PREFIX + driver);
    } catch {
      // Nothing to clear.
    }
  }
}
