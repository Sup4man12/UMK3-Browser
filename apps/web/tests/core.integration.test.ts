// Runs the real WASM core in Node through the same EmulatorAdapter and ROM
// resolver the GameWorker uses.
//
// Requires `npm run build:wasm`. The gameplay checks additionally need ROMs in
// data/roms/ (git-ignored) or in the directory given by UMK3_ROM_DIR: umk3.zip
// + umk3p.zip, or umk3.zip + the UMK3 Plus patch zip.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Button } from "@umk3/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { EmulatorAdapter } from "../src/game/EmulatorAdapter";
import { initializeCmos, restartFromBootSnapshot, stateHash } from "../src/game/firstBoot";
import { Lockstep } from "../src/game/netplay/Lockstep";
import { packState, SyncReceiver } from "../src/game/netplay/StateSync";
import { decodeNetMessage, encodeNetMessage } from "@umk3/protocol";
import { GAME_DRIVER } from "../src/game/messages";
import { formatCrc } from "../src/game/rom/crc32";
import { extractFiles, resolveRomSet } from "../src/game/rom/romset";

const CORE_PATH = resolve(import.meta.dirname, "../../../emulator/dist/fbneo_core.mjs");
const DEFAULT_ROM_DIR = resolve(import.meta.dirname, "../../../data/roms");
const ROM_DIR = process.env.UMK3_ROM_DIR ?? (existsSync(DEFAULT_ROM_DIR) ? DEFAULT_ROM_DIR : undefined);
const SAMPLE_RATE = 48_000;

const coreBuilt = existsSync(CORE_PATH);

async function loadCore(): Promise<EmulatorAdapter> {
  return EmulatorAdapter.load(pathToFileURL(CORE_PATH).href);
}

/** FNV-1a, enough to compare frames between runs. */
function hash(data: Uint8Array | Uint8ClampedArray): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i]!, 0x01000193);
  }
  return h >>> 0;
}

/** Scripted inputs: insert a coin, press start, then walk and punch. */
function scriptedInput(frame: number): number {
  if (frame >= 300 && frame < 305) return Button.Coin;
  if (frame >= 400 && frame < 405) return Button.Start;
  if (frame >= 500) return (frame % 40 < 20 ? Button.Right : Button.Left) | (frame % 16 === 0 ? Button.Fire1 : 0);
  return 0;
}

describe.skipIf(!coreBuilt)("FBNeo WASM core", () => {
  it(`exposes the ${GAME_DRIVER} driver with the expected ROM set`, async () => {
    const core = await loadCore();
    const { fullName, slots } = core.selectDriver(GAME_DRIVER);

    expect(fullName).toBe("Ultimate Mortal Kombat 3 Plus (Hack, Beta 2)");
    expect(slots).toHaveLength(31);
    const byName = Object.fromEntries(slots.map((s) => [s.name, s]));
    // Patched program / sound ROMs and one of the four new graphics ROMs.
    expect(formatCrc(byName["u54_umk3plus.u54"]!.crc)).toBe("54a5359f");
    expect(formatCrc(byName["u63_umk3plus.u63"]!.crc)).toBe("fb83320d");
    expect(formatCrc(byName["l2.0_mortal_kombat_3_u2_umk3plus.u2"]!.crc)).toBe("2c7f4a1d");
    expect(formatCrc(byName["umk3p-u117.bin"]!.crc)).toBe("52ee547e");
    // Only the protection PIC dump is optional.
    expect(slots.filter((s) => s.optional).map((s) => s.name)).toEqual(["463_mk3_ultimate.u64"]);
  });

  it("fails cleanly when ROMs are missing", async () => {
    const core = await loadCore();
    core.selectDriver(GAME_DRIVER);
    expect(() => core.start(SAMPLE_RATE)).toThrow(/missing or invalid ROM data/);
    expect(() => core.runFrame(true)).toThrow();
  });
});

describe.skipIf(!coreBuilt || !ROM_DIR)("UMK3 Plus gameplay (needs ROMs in data/roms)", () => {
  let romFiles: ReturnType<typeof extractFiles>;

  beforeAll(() => {
    const dir = ROM_DIR!;
    romFiles = extractFiles(
      readdirSync(dir).map((name) => ({ name, data: new Uint8Array(readFileSync(join(dir, name))) })),
    );
  });

  async function startGame(): Promise<EmulatorAdapter> {
    const core = await loadCore();
    const { slots } = core.selectDriver(GAME_DRIVER);
    const resolution = resolveRomSet(slots, romFiles);
    const missing = resolution.report.filter((r) => r.status.kind === "missing" && !r.slot.optional);
    expect(missing.map((m) => m.slot.name)).toEqual([]);
    for (const [index, data] of resolution.roms) {
      core.setRom(index, data);
    }
    core.start(SAMPLE_RATE);
    return core;
  }

  it("boots, renders non-blank frames, produces audio and runs faster than real time", async () => {
    const core = await startGame();
    const video = core.videoInfo!;
    expect(video.fps).toBeCloseTo(54.71, 2);

    const distinctFrames = new Set<number>();
    let audioPeak = 0;
    const frames = 1200;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      core.setInput(0, scriptedInput(f));
      core.runFrame(true);
      if (f % 30 === 0) distinctFrames.add(hash(core.videoFrameView()));
      for (const s of core.audioFrame()) audioPeak = Math.max(audioPeak, Math.abs(s));
    }
    const msPerFrame = (performance.now() - t0) / frames;
    console.info(
      `[umk3p] ${video.width}x${video.height} @ ${video.fps} Hz, ${msPerFrame.toFixed(2)} ms/frame ` +
        `(${(1000 / msPerFrame).toFixed(0)} fps max), ${distinctFrames.size} distinct sampled frames, audio peak ${audioPeak}`,
    );

    expect(distinctFrames.size).toBeGreaterThan(5);
    expect(audioPeak).toBeGreaterThan(0);
    expect(msPerFrame).toBeLessThan(1000 / video.fps);
  });

  it("is deterministic: two instances with the same inputs produce identical frames", async () => {
    const [a, b] = await Promise.all([startGame(), startGame()]);
    for (let f = 0; f < 900; f++) {
      a.setInput(0, scriptedInput(f));
      b.setInput(0, scriptedInput(f));
      a.runFrame(true);
      b.runFrame(true);
      if (f % 60 === 59) {
        expect(hash(a.videoFrameView()), `frame ${f}`).toBe(hash(b.videoFrameView()));
      }
    }
    expect(hash(a.saveState())).toBe(hash(b.saveState()));
  });

  it("restores a save state exactly", async () => {
    const core = await startGame();
    for (let f = 0; f < 600; f++) {
      core.setInput(0, scriptedInput(f));
      core.runFrame(false);
    }
    const state = core.saveState();

    const runAndHash = () => {
      for (let f = 600; f < 700; f++) {
        core.setInput(0, scriptedInput(f));
        core.runFrame(f === 699);
      }
      return hash(core.videoFrameView());
    };

    const first = runAndHash();
    core.loadState(state);
    expect(runAndHash()).toBe(first);
  });

  it("initializeCmos skips the CMOS INVALID screen on every new session", async () => {
    // Samples frames 300..1200 with no input at all.
    const sample = (core: EmulatorAdapter) => {
      const hashes = new Set<number>();
      for (let f = 1; f <= 1200; f++) {
        const render = f >= 300 && f % 300 === 0;
        core.runFrame(render);
        if (render) hashes.add(hash(core.videoFrameView()));
      }
      return hashes.size;
    };

    // Cold boot: the game freezes on "CMOS INVALID ... ANY BUTTON TO CONTINUE".
    expect(sample(await startGame())).toBe(1);

    const [a, b] = await Promise.all([startGame(), startGame()]);
    const frames = initializeCmos(a);
    initializeCmos(b);
    console.info(`[umk3p] factory CMOS written after ${frames} off-screen frames`);
    expect(frames).toBeLessThan(600);
    expect(hash(a.nvram())).toBe(hash(b.nvram()));
    // After the reset the normal boot / attract sequence runs.
    expect(sample(a)).toBeGreaterThan(1);
  });

  it("online match: two cores in lockstep over a lossy link stay identical", async () => {
    // Mirrors GameWorker: boot, initializeCmos, snapshot; peer A plays offline first.
    const [a, b] = await Promise.all([startGame(), startGame()]);
    const bootCmos: Uint8Array[] = [];
    const snapshots = [a, b].map((core) => {
      initializeCmos(core);
      bootCmos.push(core.nvram());
      return core.saveState();
    });
    expect(stateHash(snapshots[0]!)).toBe(stateHash(snapshots[1]!));
    for (let f = 0; f < 700; f++) {
      a.setInput(0, scriptedInput(f));
      a.runFrame(false);
    }

    const cores = [a, b];
    // Both start from identical machines: the boot snapshot with each one's boot CMOS (equal
    // here). A's live CMOS now has coin audits that B's lacks; the app avoids that case by
    // sending Player 1's machine to Player 2 instead of restarting both independently.
    expect(stateHash(bootCmos[0]!)).toBe(stateHash(bootCmos[1]!));
    cores.forEach((core, i) => restartFromBootSnapshot(core, snapshots[i]!, bootCmos[i]!));
    const peers = [0, 1].map((p) => new Lockstep({ localPlayer: p as 0 | 1, inputDelay: 3, sessionId: 77 }));
    let seed = 12345;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const inFlight: { at: number; to: number; bytes: ArrayBuffer }[] = [];
    const frames = [0, 0];
    const hashes: Map<number, number>[] = [new Map(), new Map()];
    const target = 1500;

    let tick = 0;
    const t0 = performance.now();
    while ((frames[0]! < target || frames[1]! < target) && tick < target * 20) {
      tick++;
      for (const p of [0, 1]) {
        const peer = peers[p]!;
        const core = cores[p]!;
        if (frames[p]! < target) {
          // Player 1 inserts coins and starts; Player 2 mashes buttons.
          const f = frames[p]!;
          const buttons = p === 0 ? scriptedInput(f + 1000) : (f * 7919) % 4096;
          peer.pushLocal(f, buttons);
          if (peer.canRun(f)) {
            const [p1, p2] = peer.inputs(f);
            core.setInput(0, p1);
            core.setInput(1, p2);
            core.runFrame(false);
            frames[p]!++;
            if (frames[p]! % 120 === 0) hashes[p]!.set(frames[p]!, stateHash(core.saveState()));
          }
        }
        const packet = peer.outgoing();
        if (packet && random() > 0.25) {
          inFlight.push({ at: tick + 1 + Math.floor(random() * 5), to: 1 - p, bytes: encodeNetMessage(packet) });
        }
      }
      for (let i = inFlight.length - 1; i >= 0; i--) {
        if (inFlight[i]!.at <= tick) {
          const { to, bytes } = inFlight.splice(i, 1)[0]!;
          const message = decodeNetMessage(bytes);
          if (message.type === "input") peers[to]!.receive(message);
        }
      }
    }
    const elapsed = performance.now() - t0;

    expect(frames).toEqual([target, target]);
    expect([...hashes[0]!.entries()]).toEqual([...hashes[1]!.entries()]);
    expect(hashes[0]!.size).toBe(Math.floor(target / 120));
    const stateBytes = a.saveState().length;
    const h0 = performance.now();
    stateHash(a.saveState());
    console.info(
      `[umk3p] lockstep: ${target} frames x2 in ${elapsed.toFixed(0)} ms over ${tick} ticks (25% loss), ` +
        `${hashes[0]!.size} matching state hashes; state ${(stateBytes / 1024).toFixed(0)} KiB, save+hash ${(performance.now() - h0).toFixed(1)} ms`,
    );
  });

  it("join in progress: a state saved by one core continues identically in another", async () => {
    // Player 1 has been playing for a while (coins, start, character select...).
    const host = await startGame();
    initializeCmos(host);
    for (let f = 0; f < 1500; f++) {
      host.setInput(0, scriptedInput(f + 1000));
      host.setInput(1, 0);
      host.runFrame(false);
    }

    // Transfer exactly as the app does: packState -> bytes on the wire -> SyncReceiver.
    const t0 = performance.now();
    const state = host.saveState();
    const wireMessages = packState(state, { sessionId: 5, inputDelay: 2, build: 1 }).map(encodeNetMessage);
    const packMs = performance.now() - t0;
    const packedBytes = wireMessages.reduce((n, m) => n + m.byteLength, 0);

    const joiner = await startGame(); // fresh core with a completely different history
    const receiver = new SyncReceiver();
    const results = wireMessages.map((bytes) => receiver.accept(decodeNetMessage(bytes) as never)).filter(Boolean);
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("complete");
    joiner.loadState((results[0] as { state: Uint8Array }).state);
    expect(stateHash(joiner.saveState())).toBe(stateHash(state));

    for (let f = 0; f < 1200; f++) {
      const p1 = scriptedInput(f + 2500);
      const p2 = (f * 7919) % 4096;
      for (const core of [host, joiner]) {
        core.setInput(0, p1);
        core.setInput(1, p2);
        core.runFrame(f % 300 === 299);
      }
      if (f % 300 === 299) {
        expect(hash(joiner.videoFrameView()), `frame ${f}`).toBe(hash(host.videoFrameView()));
        expect(stateHash(joiner.saveState()), `state at ${f}`).toBe(stateHash(host.saveState()));
      }
    }
    console.info(
      `[umk3p] join sync: state ${(state.length / 1024).toFixed(0)} KiB -> ${(packedBytes / 1024).toFixed(0)} KiB ` +
        `in ${wireMessages.length} messages, packed in ${packMs.toFixed(1)} ms; 1200 frames identical after transfer`,
    );
  });

  const NVRAM_FILE = resolve(import.meta.dirname, "../../../data/nvram/umk3p.fs");
  it.skipIf(!existsSync(NVRAM_FILE))("boots straight into the game with data/nvram/umk3p.fs as CMOS", async () => {
    const core = await startGame();
    const fs = new Uint8Array(readFileSync(NVRAM_FILE));
    expect(fs.length).toBe(core.nvram().length);
    core.loadNvram(fs); // as GameWorker does: before the first frame
    expect(hash(core.nvram())).toBe(hash(fs));

    // With an invalid CMOS the game would freeze on "CMOS INVALID ... ANY BUTTON".
    const sampled = new Set<number>();
    for (let f = 1; f <= 1200; f++) {
      const render = f >= 300 && f % 300 === 0;
      core.runFrame(render);
      if (render) sampled.add(hash(core.videoFrameView()));
    }
    expect(sampled.size).toBeGreaterThan(1);
  });

  it("a restart keeps the player's current CMOS (settings are battery backed)", async () => {
    const core = await startGame();
    initializeCmos(core);
    const boot = core.saveState();
    const bootCmos = core.nvram();
    // Play a little: inserting coins updates the CMOS audits, like changing a setting would.
    for (let f = 0; f < 700; f++) {
      core.setInput(0, scriptedInput(f));
      core.runFrame(false);
    }
    const changed = core.nvram();
    expect(hash(changed)).not.toBe(hash(bootCmos));

    restartFromBootSnapshot(core, boot, changed);
    expect(hash(core.nvram())).toBe(hash(changed));
    for (let f = 0; f < 300; f++) {
      core.setInput(0, 0);
      core.runFrame(false);
    }
    // Still the player's CMOS after the reboot (the game may only append to it, never revert it).
    expect(hash(core.nvram())).not.toBe(hash(bootCmos));
  });
});
