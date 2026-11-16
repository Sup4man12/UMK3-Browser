import { describe, expect, it } from "vitest";
import { Button } from "./buttons";
import {
  NO_FRAME,
  NetMessageError,
  SYNC_CHUNK_BYTES,
  buildId,
  decodeNetMessage,
  encodeNetMessage,
  inputDelayForRtt,
  type NetMessage,
} from "./netplay";

describe("netplay binary messages", () => {
  const messages: NetMessage[] = [
    {
      type: "input",
      sessionId: 0xdeadbeef,
      player: 1,
      ack: NO_FRAME,
      firstFrame: 1234,
      buttons: [0, Button.Left | Button.Fire1, Button.Start],
    },
    { type: "ping", id: 7, sentAt: 1234.5678 },
    { type: "pong", id: 7, sentAt: 1234.5678 },
    { type: "state-hash", sessionId: 1, frame: 240, hash: 0xcafebabe },
    {
      type: "sync-begin",
      sessionId: 9,
      inputDelay: 2,
      build: 0x691a063c,
      packedBytes: 68_000,
      stateBytes: 2_455_552,
      stateHash: 0x12345678,
    },
    { type: "sync-chunk", sessionId: 9, offset: 16384, data: new Uint8Array([1, 2, 3, 250]) },
  ];

  it.each(messages)("round-trips $type", (message) => {
    expect(decodeNetMessage(encodeNetMessage(message))).toEqual(message);
  });

  it("uses the documented input layout", () => {
    const bytes = new Uint8Array(
      encodeNetMessage({ type: "input", sessionId: 1, player: 0, ack: 2, firstFrame: 3, buttons: [0x0405] }),
    );
    expect([...bytes]).toEqual([2, 1, 0, 1, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0x05, 0x04]);
  });

  it("decodes from a view with an offset", () => {
    const encoded = new Uint8Array(encodeNetMessage(messages[1]!));
    const backing = new Uint8Array(encoded.length + 3);
    backing.set(encoded, 3);
    expect(decodeNetMessage(backing.subarray(3))).toEqual(messages[1]);
  });

  it("rejects values that do not fit the wire format", () => {
    const input = messages[0] as Extract<NetMessage, { type: "input" }>;
    expect(() => encodeNetMessage({ ...input, buttons: [] })).toThrow(RangeError);
    expect(() => encodeNetMessage({ ...input, buttons: new Array(65).fill(0) })).toThrow(RangeError);
    expect(() => encodeNetMessage({ ...input, buttons: [1 << 12] })).toThrow(RangeError);
    expect(() => encodeNetMessage({ ...input, firstFrame: -1 })).toThrow(RangeError);
  });

  it("rejects malformed messages", () => {
    const bytes = new Uint8Array(encodeNetMessage(messages[0]!));
    expect(() => decodeNetMessage(bytes.subarray(0, 17))).toThrow(NetMessageError);

    const badVersion = bytes.slice();
    badVersion[0] = 1;
    expect(() => decodeNetMessage(badVersion)).toThrow(/version/);

    const badType = bytes.slice();
    badType[1] = 99;
    expect(() => decodeNetMessage(badType)).toThrow(/unknown/);

    const badPlayer = bytes.slice();
    badPlayer[2] = 2;
    expect(() => decodeNetMessage(badPlayer)).toThrow(/player/);

    const badButtons = bytes.slice();
    badButtons[19] = 0xf0;
    expect(() => decodeNetMessage(badButtons)).toThrow(/button/);
  });

  it("rejects oversized or empty sync chunks and absurd sync sizes", () => {
    expect(() =>
      encodeNetMessage({ type: "sync-chunk", sessionId: 1, offset: 0, data: new Uint8Array(SYNC_CHUNK_BYTES + 1) }),
    ).toThrow(RangeError);
    expect(() => encodeNetMessage({ type: "sync-chunk", sessionId: 1, offset: 0, data: new Uint8Array() })).toThrow(
      RangeError,
    );
    const begin = new Uint8Array(
      encodeNetMessage({ type: "sync-begin", sessionId: 1, inputDelay: 2, build: 1, packedBytes: 10, stateBytes: 10, stateHash: 0 }),
    );
    new DataView(begin.buffer).setUint32(12, 0xffffffff, true);
    expect(() => decodeNetMessage(begin)).toThrow(/sync size/);
  });
});

describe("inputDelayForRtt (mirrors the server's InputDelayPolicy)", () => {
  it.each([
    [null, 3],
    [1, 2],
    [100, 4],
    [10_000, 8],
  ])("rtt %s ms -> %i frames", (rtt, delay) => {
    expect(inputDelayForRtt(rtt)).toBe(delay);
  });

  it("derives the build id from the wasm hash", () => {
    expect(buildId("691a063c63b2dc32")).toBe(0x691a063c);
    expect(buildId("unknown")).toBe(0);
  });
});
