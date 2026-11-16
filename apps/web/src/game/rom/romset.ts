import { unzipSync } from "fflate";
import { crc32 } from "./crc32";
import { applyIps, isIpsPatch } from "./ips";

/** One ROM the selected FBNeo driver needs, as reported by the core. */
export interface RomSlot {
  index: number;
  name: string;
  length: number;
  crc: number;
  optional: boolean;
}

/** A file supplied by the user, after archive extraction. */
export interface RomFile {
  /** "archive.zip/entry.bin" or the plain file name. */
  name: string;
  data: Uint8Array;
}

export type SlotStatus =
  | { kind: "found"; file: string }
  | { kind: "patched"; base: string; patch: string }
  | { kind: "missing" };

export interface SlotReport {
  slot: RomSlot;
  status: SlotStatus;
}

export interface RomSetResolution {
  /** Verified data by slot index (CRC and length match the driver). */
  roms: Map<number, Uint8Array>;
  report: SlotReport[];
  /** True when every non-optional slot has verified data. */
  complete: boolean;
}

/** Expands .zip archives (one level) and keeps other files as-is. */
export function extractFiles(files: { name: string; data: Uint8Array }[]): RomFile[] {
  const out: RomFile[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      out.push(file);
      continue;
    }
    const entries = unzipSync(file.data);
    for (const [entryName, data] of Object.entries(entries)) {
      if (!entryName.endsWith("/")) {
        out.push({ name: `${file.name}/${entryName}`, data });
      }
    }
  }
  return out;
}

/**
 * Matches user files to driver slots by CRC-32 + length (never by file name:
 * MAME, FBNeo and the UMK3 Plus package all name the same chips differently).
 *
 * Slots that no file matches directly are derived by applying each supplied
 * IPS patch to each binary file and keeping the result only if its CRC-32 is
 * exactly the one the driver expects. This is how UMK3 Plus is built from a
 * legally owned UMK3 rev 1.2 set plus the authors' patch package without the
 * app hard-coding which patch belongs to which chip.
 */
export function resolveRomSet(slots: RomSlot[], files: RomFile[]): RomSetResolution {
  const patches = files.filter((f) => isIpsPatch(f.data));
  const binaries = files.filter((f) => !isIpsPatch(f.data));

  const byCrc = new Map<string, RomFile>();
  for (const file of binaries) {
    byCrc.set(`${crc32(file.data)}:${file.data.length}`, file);
  }

  const roms = new Map<number, Uint8Array>();
  const report: SlotReport[] = [];

  for (const slot of slots) {
    const direct = byCrc.get(`${slot.crc >>> 0}:${slot.length}`);
    if (direct) {
      roms.set(slot.index, direct.data);
      report.push({ slot, status: { kind: "found", file: direct.name } });
      continue;
    }

    const patched = derivePatched(slot, binaries, patches);
    if (patched) {
      roms.set(slot.index, patched.data);
      report.push({ slot, status: { kind: "patched", base: patched.base, patch: patched.patch } });
      continue;
    }

    report.push({ slot, status: { kind: "missing" } });
  }

  const complete = report.every((r) => r.slot.optional || r.status.kind !== "missing");
  return { roms, report, complete };
}

function derivePatched(slot: RomSlot, binaries: RomFile[], patches: RomFile[]) {
  if (slot.optional) {
    return undefined;
  }
  for (const patch of patches) {
    for (const base of binaries) {
      // IPS only grows a file (or truncates with the Lunar extension); a base
      // larger than the target cannot be the right one in practice.
      if (base.data.length > slot.length) {
        continue;
      }
      let data: Uint8Array;
      try {
        data = applyIps(base.data, patch.data);
      } catch {
        break; // malformed patch: no base will make it valid
      }
      if (data.length === slot.length && crc32(data) === slot.crc >>> 0) {
        return { data, base: base.name, patch: patch.name };
      }
    }
  }
  return undefined;
}
