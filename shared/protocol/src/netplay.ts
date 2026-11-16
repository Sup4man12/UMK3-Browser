import { BUTTON_MASK } from "./buttons";

/**
 * Binary peer-to-peer messages of the delay-based netcode. They travel over
 * the WebRTC DataChannel (unordered, no retransmission) or, as a fallback,
 * through the signaling server's binary relay. Little-endian throughout.
 *
 * Common header: u8 version, u8 type.
 *
 * Input (redundant: carries every local input the peer has not acknowledged)
 *   0  u8   version         4  u32 sessionId
 *   1  u8   type = 1        8  u32 ack: highest frame of the *receiver's* input
 *   2  u8   player              that the sender already has contiguously
 *   3  u8   count (1..64)       (NO_FRAME when none)
 *                           12  u32 firstFrame
 *                           16  u16 buttons[count]  (firstFrame, firstFrame + 1, ...)
 *
 * Ping / Pong: u8 version, u8 type, u16 0, u32 id, f64 sentAt (echoed back)
 *
 * StateHash: u8 version, u8 type, u16 0, u32 sessionId, u32 frame, u32 hash
 *
 * Join in progress: Player 1 (always the state authority) sends its running
 * machine to Player 2 over a *reliable* path, then both run in lockstep from
 * that point (match frame 0).
 *
 * SyncBegin (24 bytes)
 *   0  u8 version, 1 u8 type = 5, 2 u8 inputDelay, 3 u8 0
 *   4  u32 sessionId    8 u32 build (first 8 hex digits of the core's wasm SHA-256)
 *   12 u32 packedBytes  16 u32 stateBytes  20 u32 stateHash (FNV-1a of the raw state)
 *
 * SyncChunk: u8 version, u8 type = 6, u16 0, u32 sessionId, u32 offset, bytes...
 *   (deflate-compressed state; chunks of at most SYNC_CHUNK_BYTES)
 */
export const NETPLAY_PROTOCOL_VERSION = 2;

export const NetMessageType = {
  Input: 1,
  Ping: 2,
  Pong: 3,
  StateHash: 4,
  SyncBegin: 5,
  SyncChunk: 6,
} as const;

/** "No frame yet" marker for acks. */
export const NO_FRAME = 0xffffffff;
export const MAX_INPUTS_PER_PACKET = 64;
/** 16 KiB is the largest DataChannel message every browser accepts without fragmentation issues. */
export const SYNC_CHUNK_BYTES = 16 * 1024;
/** Upper bound for a whole sync transfer (the deflated UMK3 state is ~70 KiB). */
export const MAX_SYNC_BYTES = 16 * 1024 * 1024;

export type NetMessage =
  | { type: "input"; sessionId: number; player: 0 | 1; ack: number; firstFrame: number; buttons: number[] }
  | { type: "ping"; id: number; sentAt: number }
  | { type: "pong"; id: number; sentAt: number }
  | { type: "state-hash"; sessionId: number; frame: number; hash: number }
  | {
      type: "sync-begin";
      sessionId: number;
      inputDelay: number;
      build: number;
      packedBytes: number;
      stateBytes: number;
      stateHash: number;
    }
  | { type: "sync-chunk"; sessionId: number; offset: number; data: Uint8Array };

export class NetMessageError extends Error {}

const U32_MAX = 0xffffffff;

function assertU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer, got ${value}`);
  }
}

export function encodeNetMessage(message: NetMessage): ArrayBuffer {
  switch (message.type) {
    case "input": {
      const count = message.buttons.length;
      if (count < 1 || count > MAX_INPUTS_PER_PACKET) {
        throw new RangeError(`input packets carry 1..${MAX_INPUTS_PER_PACKET} frames, got ${count}`);
      }
      assertU32("sessionId", message.sessionId);
      assertU32("ack", message.ack);
      assertU32("firstFrame", message.firstFrame);
      const buffer = new ArrayBuffer(16 + count * 2);
      const view = new DataView(buffer);
      view.setUint8(0, NETPLAY_PROTOCOL_VERSION);
      view.setUint8(1, NetMessageType.Input);
      view.setUint8(2, message.player);
      view.setUint8(3, count);
      view.setUint32(4, message.sessionId, true);
      view.setUint32(8, message.ack, true);
      view.setUint32(12, message.firstFrame, true);
      message.buttons.forEach((buttons, i) => {
        if (!Number.isInteger(buttons) || buttons < 0 || (buttons & ~BUTTON_MASK) !== 0) {
          throw new RangeError(`buttons has bits outside BUTTON_MASK: ${buttons}`);
        }
        view.setUint16(16 + i * 2, buttons, true);
      });
      return buffer;
    }
    case "ping":
    case "pong": {
      assertU32("id", message.id);
      const buffer = new ArrayBuffer(16);
      const view = new DataView(buffer);
      view.setUint8(0, NETPLAY_PROTOCOL_VERSION);
      view.setUint8(1, message.type === "ping" ? NetMessageType.Ping : NetMessageType.Pong);
      view.setUint32(4, message.id, true);
      view.setFloat64(8, message.sentAt, true);
      return buffer;
    }
    case "sync-begin": {
      for (const key of ["sessionId", "build", "packedBytes", "stateBytes", "stateHash"] as const) {
        assertU32(key, message[key]);
      }
      if (!Number.isInteger(message.inputDelay) || message.inputDelay < 1 || message.inputDelay > 32) {
        throw new RangeError(`invalid input delay ${message.inputDelay}`);
      }
      const buffer = new ArrayBuffer(24);
      const view = new DataView(buffer);
      view.setUint8(0, NETPLAY_PROTOCOL_VERSION);
      view.setUint8(1, NetMessageType.SyncBegin);
      view.setUint8(2, message.inputDelay);
      view.setUint32(4, message.sessionId, true);
      view.setUint32(8, message.build, true);
      view.setUint32(12, message.packedBytes, true);
      view.setUint32(16, message.stateBytes, true);
      view.setUint32(20, message.stateHash, true);
      return buffer;
    }
    case "sync-chunk": {
      assertU32("sessionId", message.sessionId);
      assertU32("offset", message.offset);
      if (message.data.length < 1 || message.data.length > SYNC_CHUNK_BYTES) {
        throw new RangeError(`sync chunks carry 1..${SYNC_CHUNK_BYTES} bytes, got ${message.data.length}`);
      }
      const buffer = new ArrayBuffer(12 + message.data.length);
      const view = new DataView(buffer);
      view.setUint8(0, NETPLAY_PROTOCOL_VERSION);
      view.setUint8(1, NetMessageType.SyncChunk);
      view.setUint32(4, message.sessionId, true);
      view.setUint32(8, message.offset, true);
      new Uint8Array(buffer, 12).set(message.data);
      return buffer;
    }
    case "state-hash": {
      assertU32("sessionId", message.sessionId);
      assertU32("frame", message.frame);
      assertU32("hash", message.hash);
      const buffer = new ArrayBuffer(16);
      const view = new DataView(buffer);
      view.setUint8(0, NETPLAY_PROTOCOL_VERSION);
      view.setUint8(1, NetMessageType.StateHash);
      view.setUint32(4, message.sessionId, true);
      view.setUint32(8, message.frame, true);
      view.setUint32(12, message.hash, true);
      return buffer;
    }
  }
}

export function decodeNetMessage(data: ArrayBuffer | ArrayBufferView): NetMessage {
  const view =
    data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.byteLength < 2) {
    throw new NetMessageError("message too short");
  }
  const version = view.getUint8(0);
  if (version !== NETPLAY_PROTOCOL_VERSION) {
    throw new NetMessageError(`unsupported protocol version ${version}`);
  }

  const type = view.getUint8(1);
  switch (type) {
    case NetMessageType.Input: {
      if (view.byteLength < 16) {
        throw new NetMessageError("truncated input packet");
      }
      const player = view.getUint8(2);
      const count = view.getUint8(3);
      if (player > 1) {
        throw new NetMessageError(`invalid player ${player}`);
      }
      if (count < 1 || count > MAX_INPUTS_PER_PACKET || view.byteLength !== 16 + count * 2) {
        throw new NetMessageError(`input packet length does not match count ${count}`);
      }
      const buttons: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = view.getUint16(16 + i * 2, true);
        if ((value & ~BUTTON_MASK) !== 0) {
          throw new NetMessageError(`invalid button bits ${value}`);
        }
        buttons.push(value);
      }
      return {
        type: "input",
        player: player as 0 | 1,
        sessionId: view.getUint32(4, true),
        ack: view.getUint32(8, true),
        firstFrame: view.getUint32(12, true),
        buttons,
      };
    }
    case NetMessageType.Ping:
    case NetMessageType.Pong:
      if (view.byteLength !== 16) {
        throw new NetMessageError("ping/pong must be 16 bytes");
      }
      return {
        type: type === NetMessageType.Ping ? "ping" : "pong",
        id: view.getUint32(4, true),
        sentAt: view.getFloat64(8, true),
      };
    case NetMessageType.StateHash:
      if (view.byteLength !== 16) {
        throw new NetMessageError("state hash must be 16 bytes");
      }
      return {
        type: "state-hash",
        sessionId: view.getUint32(4, true),
        frame: view.getUint32(8, true),
        hash: view.getUint32(12, true),
      };
    case NetMessageType.SyncBegin: {
      if (view.byteLength !== 24) {
        throw new NetMessageError("sync-begin must be 24 bytes");
      }
      const packedBytes = view.getUint32(12, true);
      const stateBytes = view.getUint32(16, true);
      const inputDelay = view.getUint8(2);
      if (packedBytes < 1 || packedBytes > MAX_SYNC_BYTES || stateBytes < 1 || stateBytes > MAX_SYNC_BYTES) {
        throw new NetMessageError(`invalid sync size ${packedBytes}/${stateBytes}`);
      }
      if (inputDelay < 1 || inputDelay > 32) {
        throw new NetMessageError(`invalid input delay ${inputDelay}`);
      }
      return {
        type: "sync-begin",
        inputDelay,
        sessionId: view.getUint32(4, true),
        build: view.getUint32(8, true),
        packedBytes,
        stateBytes,
        stateHash: view.getUint32(20, true),
      };
    }
    case NetMessageType.SyncChunk: {
      const length = view.byteLength - 12;
      if (length < 1 || length > SYNC_CHUNK_BYTES) {
        throw new NetMessageError(`invalid sync chunk length ${length}`);
      }
      return {
        type: "sync-chunk",
        sessionId: view.getUint32(4, true),
        offset: view.getUint32(8, true),
        data: new Uint8Array(view.buffer, view.byteOffset + 12, length),
      };
    }
    default:
      throw new NetMessageError(`unknown message type ${type}`);
  }
}

/** UMK3 runs at 54.71 Hz (Midway Wolf-unit), not 60 Hz. */
export const FRAME_MS = 1000 / 54.71;
export const MIN_INPUT_DELAY = 2;
export const MAX_INPUT_DELAY = 8;
export const DEFAULT_INPUT_DELAY = 3;

/**
 * Input delay in frames for a round trip: one-way latency plus one frame of
 * margin, clamped to 2..8. Mirrors com.umk3.signaling.InputDelayPolicy.
 */
export function inputDelayForRtt(rttMs: number | null): number {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs < 0) {
    return DEFAULT_INPUT_DELAY;
  }
  const frames = Math.ceil(rttMs / 2 / FRAME_MS) + 1;
  return Math.min(MAX_INPUT_DELAY, Math.max(MIN_INPUT_DELAY, frames));
}

/** Build id carried by sync-begin: the first 32 bits of the wasm SHA-256 (hex). */
export function buildId(wasmSha256: string): number {
  const id = Number.parseInt(wasmSha256.slice(0, 8), 16);
  return Number.isFinite(id) ? id >>> 0 : 0;
}
