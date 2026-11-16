import { describe, expect, it } from "vitest";
import { NvramStore, type KeyValueStorage } from "./nvramStore";

class MemoryStorage implements KeyValueStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

describe("NvramStore", () => {
  const nvram = new Uint8Array(32768).map((_, i) => (i * 31) & 0xff);

  it("round-trips a full 32 KiB CMOS per driver", () => {
    const storage = new MemoryStorage();
    const store = new NvramStore(storage);
    expect(store.load("umk3p")).toBeNull();
    expect(store.save("umk3p", nvram)).toBe(true);
    expect(store.load("umk3p")).toEqual(nvram);
    expect(store.load("other")).toBeNull();
    expect([...storage.items.keys()]).toEqual(["umk3.nvram.v1.umk3p"]);
  });

  it("clears", () => {
    const store = new NvramStore(new MemoryStorage());
    store.save("umk3p", nvram);
    store.clear("umk3p");
    expect(store.load("umk3p")).toBeNull();
  });

  it("survives a browser that refuses or corrupts storage", () => {
    const full: KeyValueStorage = {
      getItem: () => "%%% not base64",
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    };
    const store = new NvramStore(full);
    expect(store.save("umk3p", nvram)).toBe(false);
    expect(store.load("umk3p")).toBeNull();

    const none = new NvramStore(null);
    expect(none.available).toBe(false);
    expect(none.save("umk3p", nvram)).toBe(false);
  });
});
