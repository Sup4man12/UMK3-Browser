import { decodeNetMessage, encodeNetMessage, SYNC_CHUNK_BYTES, type NetMessage } from "@umk3/protocol";
import { describe, expect, it } from "vitest";
import { packState, SyncReceiver } from "./StateSync";

/** A state that does not compress to a single chunk. */
function fakeState(bytes: number, seed: number): Uint8Array {
  const state = new Uint8Array(bytes);
  let x = seed;
  for (let i = 0; i < bytes; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    state[i] = i % 7 === 0 ? x >>> 24 : 0; // partly compressible, like a RAM dump
  }
  return state;
}

type SyncMessage = Extract<NetMessage, { type: "sync-begin" | "sync-chunk" }>;
const wire = (messages: NetMessage[]) =>
  messages.map((m) => decodeNetMessage(encodeNetMessage(m)) as SyncMessage);

describe("state sync", () => {
  const state = fakeState(400_000, 1);
  const messages = wire(packState(state, { sessionId: 7, inputDelay: 2, build: 1 }));

  it("splits into a sync-begin plus chunks that fit the wire limit", () => {
    expect(messages[0]!.type).toBe("sync-begin");
    expect(messages.length).toBeGreaterThan(2);
    for (const m of messages.slice(1)) {
      expect(m.type === "sync-chunk" && m.data.length <= SYNC_CHUNK_BYTES).toBe(true);
    }
  });

  it("reassembles the exact state in order", () => {
    const receiver = new SyncReceiver();
    const results = messages.map((m) => receiver.accept(m));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toEqual({ kind: "complete", sessionId: 7, inputDelay: 2, state });
  });

  it("does not depend on arrival order and ignores duplicates", () => {
    const receiver = new SyncReceiver();
    const shuffled = [...messages.slice(2), messages[1]!, messages[2]!, messages[0]!]; // begin last
    const results = shuffled.map((m) => receiver.accept(m)).filter((r) => r !== null);
    expect(results).toEqual([{ kind: "complete", sessionId: 7, inputDelay: 2, state }]);
  });

  it("rejects a transfer whose content does not match the announced hash", () => {
    const receiver = new SyncReceiver();
    const [begin, ...chunks] = messages;
    receiver.accept({ ...(begin as Extract<SyncMessage, { type: "sync-begin" }>), stateHash: 123 });
    const results = chunks.map((c) => receiver.accept(c)).filter((r) => r !== null);
    expect(results).toEqual([{ kind: "error", sessionId: 7, message: "estado recebido não confere com o hash" }]);
  });

  it("a newer session replaces an unfinished one", () => {
    const receiver = new SyncReceiver();
    receiver.accept(messages[0]!);
    receiver.accept(messages[1]!);
    const newer = fakeState(100_000, 2);
    const results = wire(packState(newer, { sessionId: 8, inputDelay: 3, build: 1 }))
      .map((m) => receiver.accept(m))
      .filter((r) => r !== null);
    expect(results).toEqual([{ kind: "complete", sessionId: 8, inputDelay: 3, state: newer }]);
    // Late chunks of the abandoned session never complete anything.
    expect(messages.slice(2).map((m) => receiver.accept(m)).every((r) => r === null)).toBe(true);
  });
});
