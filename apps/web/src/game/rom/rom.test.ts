import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32, formatCrc } from "./crc32";
import { IpsError, applyIps, isIpsPatch } from "./ips";
import { extractFiles, resolveRomSet, type RomSlot } from "./romset";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

function ips(records: number[][], truncate?: number): Uint8Array {
  return new Uint8Array([
    ...ascii("PATCH"),
    ...records.flat(),
    ...ascii("EOF"),
    ...(truncate === undefined ? [] : u24(truncate)),
  ]);
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(formatCrc(crc32(new TextEncoder().encode("123456789")))).toBe("cbf43926");
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("applyIps", () => {
  const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

  it("applies literal records without touching the source", () => {
    const out = applyIps(source, ips([[...u24(2), ...u16(2), 0xaa, 0xbb]]));
    expect([...out]).toEqual([0, 1, 0xaa, 0xbb, 4, 5, 6, 7]);
    expect([...source]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("applies RLE records", () => {
    const out = applyIps(source, ips([[...u24(1), ...u16(0), ...u16(3), 0xee]]));
    expect([...out]).toEqual([0, 0xee, 0xee, 0xee, 4, 5, 6, 7]);
  });

  it("grows the output when a record writes past the end", () => {
    const out = applyIps(source, ips([[...u24(9), ...u16(1), 0x99]]));
    expect([...out]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 0x99]);
  });

  it("honours the Lunar IPS truncation extension", () => {
    expect(applyIps(source, ips([], 4)).length).toBe(4);
  });

  it("rejects malformed patches", () => {
    expect(isIpsPatch(new Uint8Array(ascii("NOTAPATCH")))).toBe(false);
    expect(() => applyIps(source, new Uint8Array(ascii("PATCH")))).toThrow(IpsError);
    const truncated = ips([[...u24(0), ...u16(4), 1, 2, 3, 4]]).slice(0, 12);
    expect(() => applyIps(source, truncated)).toThrow(/truncated/);
    const trailing = new Uint8Array([...ips([]), 1]);
    expect(() => applyIps(source, trailing)).toThrow(/trailing/);
  });
});

describe("resolveRomSet", () => {
  const prg = new Uint8Array([1, 2, 3, 4]);
  const gfx = new Uint8Array([9, 9, 9, 9, 9, 9]);
  const patch = ips([[...u24(0), ...u16(1), 0x7f]]);
  const patchedPrg = applyIps(prg, patch);

  const slots: RomSlot[] = [
    { index: 0, name: "hack.u54", length: 4, crc: crc32(patchedPrg), optional: false },
    { index: 1, name: "gfx.u133", length: 6, crc: crc32(gfx), optional: false },
    { index: 2, name: "pic.u64", length: 16, crc: 0x12345678, optional: true },
  ];

  it("matches by CRC regardless of file name and derives patched slots", () => {
    const result = resolveRomSet(slots, [
      { name: "some-other-name.bin", data: gfx },
      { name: "base.u54", data: prg },
      { name: "hack.ips", data: patch },
    ]);

    expect(result.complete).toBe(true);
    expect(result.report.map((r) => r.status)).toEqual([
      { kind: "patched", base: "base.u54", patch: "hack.ips" },
      { kind: "found", file: "some-other-name.bin" },
      { kind: "missing" },
    ]);
    expect([...result.roms.get(0)!]).toEqual([0x7f, 2, 3, 4]);
    expect(result.roms.has(2)).toBe(false);
  });

  it("reports incomplete sets", () => {
    const result = resolveRomSet(slots, [{ name: "base.u54", data: prg }]);
    expect(result.complete).toBe(false);
    expect(result.report[0]!.status.kind).toBe("missing");
  });

  it("does not accept a file whose CRC matches but length does not", () => {
    const wrongLength: RomSlot = { ...slots[1]!, length: 7 };
    expect(resolveRomSet([wrongLength], [{ name: "gfx", data: gfx }]).complete).toBe(false);
  });
});

describe("extractFiles", () => {
  it("expands zip archives and keeps loose files", () => {
    const zip = zipSync({ "a.bin": new Uint8Array([1]), "dir/b.bin": new Uint8Array([2]), "dir/": new Uint8Array() });
    const files = extractFiles([
      { name: "set.zip", data: zip },
      { name: "loose.ips", data: new Uint8Array([3]) },
    ]);
    expect(files.map((f) => f.name).sort()).toEqual(["loose.ips", "set.zip/a.bin", "set.zip/dir/b.bin"]);
  });
});
