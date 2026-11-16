// IPS patch format, as produced by Lunar IPS (the tool the UMK3 Plus authors
// tell users to apply their patches with):
//
//   "PATCH"
//   record*:  offset u24 BE, size u16 BE, size bytes of data
//             size == 0 -> RLE record: run length u16 BE, value u8
//   "EOF"
//   optional: truncate length u24 BE (Lunar IPS extension)
//
// A patch may write past the end of the source file, which grows the output.

const HEADER = [0x50, 0x41, 0x54, 0x43, 0x48]; // "PATCH"
const EOF_MARKER = 0x454f46; // "EOF"

export class IpsError extends Error {}

export function isIpsPatch(data: Uint8Array): boolean {
  return data.length >= 8 && HEADER.every((byte, i) => data[i] === byte);
}

interface IpsRecord {
  offset: number;
  /** Literal bytes, or undefined for an RLE record. */
  data?: Uint8Array;
  rleLength: number;
  rleValue: number;
}

interface ParsedIps {
  records: IpsRecord[];
  truncateTo?: number;
}

function parseIps(patch: Uint8Array): ParsedIps {
  if (!isIpsPatch(patch)) {
    throw new IpsError("missing PATCH header");
  }

  const records: IpsRecord[] = [];
  let pos = HEADER.length;
  const need = (bytes: number) => {
    if (pos + bytes > patch.length) {
      throw new IpsError(`truncated patch at byte ${pos}`);
    }
  };

  for (;;) {
    need(3);
    const offset = (patch[pos]! << 16) | (patch[pos + 1]! << 8) | patch[pos + 2]!;
    pos += 3;
    if (offset === EOF_MARKER) {
      break;
    }

    need(2);
    const size = (patch[pos]! << 8) | patch[pos + 1]!;
    pos += 2;
    if (size > 0) {
      need(size);
      records.push({ offset, data: patch.subarray(pos, pos + size), rleLength: 0, rleValue: 0 });
      pos += size;
    } else {
      need(3);
      const rleLength = (patch[pos]! << 8) | patch[pos + 1]!;
      records.push({ offset, rleLength, rleValue: patch[pos + 2]! });
      pos += 3;
    }
  }

  let truncateTo: number | undefined;
  if (pos === patch.length - 3) {
    truncateTo = (patch[pos]! << 16) | (patch[pos + 1]! << 8) | patch[pos + 2]!;
  } else if (pos !== patch.length) {
    throw new IpsError(`unexpected ${patch.length - pos} trailing bytes after EOF`);
  }
  return { records, truncateTo };
}

/** Returns a new buffer; `source` is not modified. */
export function applyIps(source: Uint8Array, patch: Uint8Array): Uint8Array {
  const { records, truncateTo } = parseIps(patch);

  let length = source.length;
  for (const r of records) {
    length = Math.max(length, r.offset + (r.data ? r.data.length : r.rleLength));
  }

  const output = new Uint8Array(length);
  output.set(source);
  for (const r of records) {
    if (r.data) {
      output.set(r.data, r.offset);
    } else {
      output.fill(r.rleValue, r.offset, r.offset + r.rleLength);
    }
  }

  return truncateTo !== undefined && truncateTo < output.length ? output.slice(0, truncateTo) : output;
}
