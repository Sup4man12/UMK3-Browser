import { NO_FRAME, decodeNetMessage, encodeNetMessage } from "@umk3/protocol";
import { describe, expect, it } from "vitest";
import { Lockstep } from "./Lockstep";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two peers advancing one "tick" at a time over a lossy, reordering link,
 * each sending its outgoing packet every tick (as the GameWorker does).
 */
function simulate(options: { frames: number; delay: number; loss: number; maxLatencyTicks: number; seed: number }) {
  const random = rng(options.seed);
  const peers = [0, 1].map((p) => new Lockstep({ localPlayer: p as 0 | 1, inputDelay: options.delay, sessionId: 9 }));
  const frame = [0, 0];
  const ran: [number, number][][] = [[], []];
  const inFlight: { at: number; to: number; bytes: ArrayBuffer }[] = [];

  let tick = 0;
  while ((frame[0]! < options.frames || frame[1]! < options.frames) && tick < options.frames * 50) {
    tick++;
    for (const p of [0, 1]) {
      const peer = peers[p]!;
      if (frame[p]! < options.frames) {
        peer.pushLocal(frame[p]!, Math.floor(random() * 4096));
        if (peer.canRun(frame[p]!)) {
          ran[p]!.push(peer.inputs(frame[p]!));
          frame[p]!++;
        }
      }
      const packet = peer.outgoing();
      if (packet && random() >= options.loss) {
        inFlight.push({ at: tick + Math.floor(random() * options.maxLatencyTicks), to: 1 - p, bytes: encodeNetMessage(packet) });
      }
    }
    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i]!.at <= tick) {
        const { to, bytes } = inFlight.splice(i, 1)[0]!;
        const message = decodeNetMessage(bytes);
        if (message.type === "input") {
          peers[to]!.receive(message);
        }
      }
    }
  }
  return { ran, frame };
}

describe("Lockstep", () => {
  it("runs the first inputDelay frames with empty inputs, then needs the peer", () => {
    const a = new Lockstep({ localPlayer: 0, inputDelay: 2, sessionId: 1 });
    a.pushLocal(0, 5);
    expect(a.inputs(0)).toEqual([0, 0]);
    a.pushLocal(1, 6);
    expect(a.inputs(1)).toEqual([0, 0]);
    a.pushLocal(2, 7);
    expect(a.canRun(2)).toBe(false); // local 5 is scheduled, remote unknown
    expect(a.outgoing()).toMatchObject({ firstFrame: 2, buttons: [5, 6, 7], ack: 1 });
  });

  it("places inputs in the right player slots", () => {
    const p1 = new Lockstep({ localPlayer: 0, inputDelay: 1, sessionId: 1 });
    const p2 = new Lockstep({ localPlayer: 1, inputDelay: 1, sessionId: 1 });
    p1.pushLocal(0, 0x10);
    p2.pushLocal(0, 0x20);
    p1.receive(p2.outgoing()!);
    p2.receive(p1.outgoing()!);
    expect(p1.inputs(1)).toEqual([0x10, 0x20]);
    expect(p2.inputs(1)).toEqual([0x10, 0x20]);
  });

  it("is idempotent while stalled on the same frame", () => {
    const a = new Lockstep({ localPlayer: 0, inputDelay: 1, sessionId: 1 });
    a.pushLocal(0, 1);
    a.pushLocal(0, 2);
    expect(a.outgoing()!.buttons).toEqual([1]);
  });

  it("stops resending inputs once acknowledged", () => {
    const a = new Lockstep({ localPlayer: 0, inputDelay: 1, sessionId: 1 });
    a.pushLocal(0, 1);
    a.pushLocal(1, 2);
    expect(a.outgoing()!.firstFrame).toBe(1);
    a.receive({ type: "input", sessionId: 1, player: 1, ack: 1, firstFrame: 1, buttons: [0] });
    expect(a.outgoing()!.firstFrame).toBe(2);
  });

  it("ignores packets from other matches or from itself", () => {
    const a = new Lockstep({ localPlayer: 0, inputDelay: 1, sessionId: 1 });
    expect(a.receive({ type: "input", sessionId: 2, player: 1, ack: NO_FRAME, firstFrame: 1, buttons: [3] })).toBe(false);
    expect(a.receive({ type: "input", sessionId: 1, player: 0, ack: NO_FRAME, firstFrame: 1, buttons: [3] })).toBe(false);
    expect(a.remoteFrames).toBe(1);
  });

  it.each([
    { loss: 0, maxLatencyTicks: 1, seed: 1 },
    { loss: 0.3, maxLatencyTicks: 6, seed: 2 },
    { loss: 0.6, maxLatencyTicks: 12, seed: 3 },
  ])("both peers see identical inputs for every frame (loss $loss, latency ≤$maxLatencyTicks)", (net) => {
    const { ran, frame } = simulate({ frames: 2000, delay: 3, ...net });
    expect(frame).toEqual([2000, 2000]);
    expect(ran[0]).toEqual(ran[1]);
  });
});
