/// <reference lib="webworker" />
// Runs the FBNeo WASM core off the main thread: ROM verification, the frame
// loop (offline, or lockstep during an online match), rendering into an
// OffscreenCanvas and feeding the AudioWorklet.

import { decodeNetMessage, encodeNetMessage, NetMessageError, type NetMessage } from "@umk3/protocol";
import type { AudioMessage } from "./audio/audio-protocol";
import { EmulatorAdapter } from "./EmulatorAdapter";
import { FramePacer } from "./FramePacer";
import { initializeCmos, restartFromBootSnapshot, stateHash } from "./firstBoot";
import {
  CORE_SAMPLE_RATE,
  GAME_DRIVER,
  type CmosSource,
  type GameCommand,
  type GameEvent,
  type RuntimeStats,
} from "./messages";
import { Lockstep } from "./netplay/Lockstep";
import { packState, SyncReceiver } from "./netplay/StateSync";
import { extractFiles, resolveRomSet, type RomSlot } from "./rom/romset";

declare const self: DedicatedWorkerGlobalScope;

const STATS_INTERVAL_MS = 1000;
/** Both peers hash their full machine state every this many match frames. */
const HASH_INTERVAL_FRAMES = 120;
/** How often (in frames, ~2 s) the CMOS is checked for changes to save in the browser. */
const NVRAM_CHECK_FRAMES = 110;

let emulator: EmulatorAdapter | null = null;
let slots: RomSlot[] = [];
let canvas: OffscreenCanvas | null = null;
let context2d: OffscreenCanvasRenderingContext2D | null = null;
let imageData: ImageData | null = null;
let audioPort: MessagePort | null = null;

let pacer: FramePacer | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let localButtons = 0;
/** Cabinet switches (test menu...), applied only offline: they are not part of the lockstep. */
let systemSwitches = 0;
let savedState: { state: Uint8Array; ownCmos: boolean } | null = null;
/** Machine right after the CMOS was set up; restarts power-cycle back to it. */
let bootSnapshot: Uint8Array | null = null;

/**
 * The local player's own CMOS, as last seen while running their own machine.
 * False while running Player 1's machine after joining it: that CMOS is not
 * ours and must never be saved in this browser.
 */
let ownCmos = true;
let ownNvram: Uint8Array | null = null;
let ownNvramHash = 0;
let framesSinceNvramCheck = 0;

interface Match {
  lockstep: Lockstep;
  /** Next match frame to run. */
  frame: number;
  stalls: number;
  waiting: boolean;
  localHashes: Map<number, number>;
  remoteHashes: Map<number, number>;
  desyncReported: boolean;
  /** Player 1 side: Player 2's first real inputs have arrived. */
  peerSynced: boolean;
}
let match: Match | null = null;
/** Player 2 side: reassembles the state sent by Player 1. */
const syncReceiver = new SyncReceiver();

let statsWindowStart = 0;
let statsFrames = 0;
let statsEmulationMs = 0;
let skippedFrames = 0;

function post(event: GameEvent, transfer: Transferable[] = []): void {
  self.postMessage(event, transfer);
}

function report(error: unknown): void {
  post({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
}

/** For errors inside the frame loop: the emulation cannot continue. */
function fail(error: unknown): void {
  stopLoop();
  report(error);
}

function requireGame(): EmulatorAdapter {
  if (!emulator?.videoInfo) {
    throw new Error("no game loaded");
  }
  return emulator;
}

function requireOffline(action: string): void {
  if (match) {
    throw new Error(`${action} não está disponível durante uma partida online`);
  }
}

async function init(coreUrl: string, target: OffscreenCanvas): Promise<void> {
  canvas = target;
  context2d = canvas.getContext("2d", { alpha: false });
  if (!context2d) {
    throw new Error("OffscreenCanvas 2D context unavailable");
  }

  emulator = await EmulatorAdapter.load(coreUrl);
  const driver = emulator.selectDriver(GAME_DRIVER);
  slots = driver.slots;
  post({ type: "CORE_READY", driver: GAME_DRIVER, driverName: driver.fullName });
}

async function fetchRoms(romsUrl: string): Promise<{ name: string; data: Uint8Array }[]> {
  const listing = await fetch(romsUrl, { cache: "no-store" });
  if (!listing.ok || !listing.headers.get("content-type")?.includes("application/json")) {
    throw new Error(
      `ROM directory not available at ${romsUrl}. ROMs are only served by the local dev/preview server from data/roms/.`,
    );
  }
  const names = (await listing.json()) as string[];
  if (names.length === 0) {
    throw new Error("No ROM files found in data/roms/ (expected umk3.zip + umk3p.zip).");
  }
  return Promise.all(
    names.map(async (name) => {
      const response = await fetch(new URL(encodeURIComponent(name), romsUrl));
      if (!response.ok) {
        throw new Error(`failed to download ROM ${name}: HTTP ${response.status}`);
      }
      return { name, data: new Uint8Array(await response.arrayBuffer()) };
    }),
  );
}

/**
 * The cabinet's CMOS from `<nvramUrl><driver>.fs` (a raw NVRAM dump, as saved by
 * FBNeo/MAME). Null when there is none or it does not fit this driver.
 */
async function fetchNvram(nvramUrl: string, expectedBytes: number): Promise<{ name: string; data: Uint8Array } | null> {
  const name = `${GAME_DRIVER}.fs`;
  let response: Response;
  try {
    response = await fetch(new URL(name, nvramUrl), { cache: "no-store" });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length !== expectedBytes) {
    report(new Error(`${name} tem ${data.length} bytes, o esperado são ${expectedBytes}: usando a CMOS de fábrica.`));
    return null;
  }
  return { name, data };
}

async function loadGame(romsUrl: string, nvramUrl: string, savedNvram: ArrayBuffer | null): Promise<void> {
  if (!emulator) {
    throw new Error("core not initialised");
  }
  if (emulator.videoInfo) {
    throw new Error("a game is already loaded");
  }

  const resolution = resolveRomSet(slots, extractFiles(await fetchRoms(romsUrl)));
  post({ type: "ROMS_CHECKED", report: resolution.report, complete: resolution.complete });
  if (!resolution.complete) {
    return;
  }

  for (const [index, data] of resolution.roms) {
    emulator.setRom(index, data);
  }
  const video = emulator.start(CORE_SAMPLE_RATE);
  // CMOS loaded before the first frame, so the game boots with those settings.
  const nvramBytes = emulator.nvram().length;
  let cmos: CmosSource;
  if (savedNvram && savedNvram.byteLength === nvramBytes) {
    emulator.loadNvram(new Uint8Array(savedNvram));
    cmos = "browser";
  } else {
    if (savedNvram) {
      report(new Error(`A CMOS salva neste navegador tem ${savedNvram.byteLength} bytes (esperado ${nvramBytes}) e foi ignorada.`));
    }
    const file = await fetchNvram(nvramUrl, nvramBytes);
    if (file) {
      emulator.loadNvram(file.data);
      cmos = "file";
    } else {
      initializeCmos(emulator);
      cmos = "factory";
    }
  }
  bootSnapshot = emulator.saveState();
  ownCmos = true;
  ownNvram = emulator.nvram();
  ownNvramHash = stateHash(ownNvram);

  canvas!.width = video.width;
  canvas!.height = video.height;
  imageData = new ImageData(video.width, video.height);
  pacer = new FramePacer(video.fps);

  post({ type: "GAME_STARTED", width: video.width, height: video.height, fps: video.fps, cmos });
}

/** Runs up to `count` frames; online, stops early when the opponent's input is missing. */
function runFrames(count: number): void {
  const game = requireGame();
  let ran = 0;

  for (let i = 0; i < count; i++) {
    if (match) {
      match.lockstep.pushLocal(match.frame, localButtons);
      if (!match.lockstep.canRun(match.frame)) {
        match.stalls++;
        match.waiting = true;
        break;
      }
      match.waiting = false;
      const [p1, p2] = match.lockstep.inputs(match.frame);
      game.setInput(0, p1);
      game.setInput(1, p2);
    } else {
      game.setInput(0, localButtons);
      game.setInput(1, 0);
    }
    game.setSystemInput(match ? 0 : systemSwitches);

    const t0 = performance.now();
    game.runFrame(true);
    statsEmulationMs += performance.now() - t0;
    statsFrames++;
    ran++;

    if (audioPort) {
      const samples = game.audioFrame();
      const message: AudioMessage = { type: "SAMPLES", samples };
      audioPort.postMessage(message, [samples.buffer]);
    }

    if (match) {
      match.frame++;
      if (match.frame % HASH_INTERVAL_FRAMES === 0) {
        shareStateHash(game, match);
      }
    }
  }

  if (match) {
    sendNet(match.lockstep.outgoing());
  }
  if (ran > 0) {
    draw(game);
    framesSinceNvramCheck += ran;
    if (framesSinceNvramCheck >= NVRAM_CHECK_FRAMES) {
      framesSinceNvramCheck = 0;
      checkOwnNvram(game);
    }
  }
}

/** Reports the player's own CMOS when it changed (test-menu settings, audits, high scores). */
function checkOwnNvram(game: EmulatorAdapter): void {
  if (!ownCmos) {
    return;
  }
  const nvram = game.nvram();
  const hash = stateHash(nvram);
  if (hash === ownNvramHash) {
    return;
  }
  ownNvram = nvram;
  ownNvramHash = hash;
  const data = nvram.slice().buffer;
  post({ type: "NVRAM_CHANGED", data }, [data]);
}

function shareStateHash(game: EmulatorAdapter, m: Match): void {
  const hash = stateHash(game.saveState());
  m.localHashes.set(m.frame, hash);
  sendNet({ type: "state-hash", sessionId: m.lockstep.sessionId, frame: m.frame, hash });
  compareHashes(m, m.frame);
}

function compareHashes(m: Match, frame: number): void {
  const local = m.localHashes.get(frame);
  const remote = m.remoteHashes.get(frame);
  if (local === undefined || remote === undefined) {
    return;
  }
  m.localHashes.delete(frame);
  m.remoteHashes.delete(frame);
  if (local !== remote && !m.desyncReported) {
    m.desyncReported = true;
    post({ type: "DESYNC", frame });
  }
}

function sendNet(message: NetMessage | null, reliable = false): void {
  if (message) {
    const data = encodeNetMessage(message);
    post({ type: "NET_SEND", data, reliable }, [data]);
  }
}

function receiveNet(data: ArrayBuffer): void {
  let message: NetMessage;
  try {
    message = decodeNetMessage(data);
  } catch (error) {
    if (error instanceof NetMessageError) {
      return; // malformed packet from the network: drop it
    }
    throw error;
  }
  if (message.type === "sync-begin" || message.type === "sync-chunk") {
    const result = syncReceiver.accept(message);
    if (result?.kind === "complete") {
      joinMatch(result.sessionId, result.inputDelay, result.state);
    } else if (result?.kind === "error") {
      report(new Error(`Sincronização falhou: ${result.message}`));
    }
    return;
  }
  if (!match) {
    return;
  }
  if (message.type === "input") {
    match.lockstep.receive(message);
    if (!match.peerSynced && match.lockstep.localPlayer === 0 && match.lockstep.remoteFrames > match.lockstep.inputDelay) {
      match.peerSynced = true;
      post({ type: "PEER_SYNCED" });
    }
  } else if (message.type === "state-hash" && message.sessionId === match.lockstep.sessionId) {
    match.remoteHashes.set(message.frame, message.hash);
    compareHashes(match, message.frame);
  }
}

function draw(game: EmulatorAdapter): void {
  if (!context2d || !imageData) {
    return;
  }
  // Copy out of WASM memory: ImageData cannot wrap a growable heap buffer.
  imageData.data.set(game.videoFrameView());
  context2d.putImageData(imageData, 0, 0);
}

function tick(): void {
  timer = null;
  if (!running || !pacer) {
    return;
  }
  try {
    const now = performance.now();
    const advanced = pacer.advance(now);
    let run = advanced.run;
    const skipped = advanced.skipped;
    skippedFrames += skipped;
    // Online: if the opponent is well ahead of us, run one extra frame to catch up
    // instead of making them wait every frame.
    if (match && run > 0 && match.lockstep.remoteFrames > match.frame + match.lockstep.inputDelay + 1) {
      run++;
    }
    if (run > 0) {
      runFrames(run);
    } else if (match) {
      // Unreliable channel: keep repeating unacknowledged inputs while waiting.
      sendNet(match.lockstep.outgoing());
    }
    maybePostStats(now);
    timer = setTimeout(tick, pacer.msUntilNextFrame(performance.now()));
  } catch (error) {
    fail(error);
  }
}

function maybePostStats(now: number): void {
  const elapsed = now - statsWindowStart;
  if (elapsed < STATS_INTERVAL_MS) {
    return;
  }
  const stats: RuntimeStats = {
    frame: requireGame().frameCounter,
    fps: (statsFrames * 1000) / elapsed,
    emulationMsPerFrame: statsFrames > 0 ? statsEmulationMs / statsFrames : 0,
    skippedFrames,
    match: match ? { frame: match.frame, stalls: match.stalls, waiting: match.waiting } : null,
  };
  post({ type: "STATS", stats });
  statsWindowStart = now;
  statsFrames = 0;
  statsEmulationMs = 0;
}

function startLoop(): void {
  requireGame();
  if (running) {
    return;
  }
  running = true;
  const now = performance.now();
  pacer!.restart(now);
  statsWindowStart = now;
  statsFrames = 0;
  statsEmulationMs = 0;
  post({ type: "RUNNING", running: true });
  tick();
}

function stopLoop(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (running) {
    running = false;
    audioPort?.postMessage({ type: "CLEAR" } satisfies AudioMessage);
    post({ type: "RUNNING", running: false });
  }
}

function newMatch(localPlayer: 0 | 1, inputDelay: number, sessionId: number): Match {
  return {
    lockstep: new Lockstep({ localPlayer, inputDelay, sessionId }),
    frame: 0,
    stalls: 0,
    waiting: false,
    localHashes: new Map(),
    remoteHashes: new Map(),
    desyncReported: false,
    peerSynced: false,
  };
}

/** A requested reset is not in the save state: apply it before a snapshot is taken or replaced. */
function settlePendingReset(game: EmulatorAdapter): void {
  if (game.resetPending) {
    game.setInput(0, 0);
    game.setInput(1, 0);
    game.runFrame(false);
  }
}

/**
 * Player 1: the running game becomes match frame 0. Commands run between
 * ticks, so the snapshot is taken at a frame boundary and no frame runs
 * between it and the start of lockstep. With `restart` (both pressed Enter),
 * the cabinet is first power-cycled with Player 1's own CMOS.
 */
function hostSync(sessionId: number, inputDelay: number, build: number, restart: boolean): void {
  const game = requireGame();
  if (restart) {
    if (!bootSnapshot) {
      throw new Error("boot snapshot missing");
    }
    checkOwnNvram(game); // capture the latest own settings before the power cycle
    restartFromBootSnapshot(game, bootSnapshot, ownCmos ? game.nvram() : ownNvram!);
    ownCmos = true;
    audioPort?.postMessage({ type: "CLEAR" } satisfies AudioMessage);
  }
  settlePendingReset(game);
  const state = game.saveState();
  for (const message of packState(state, { sessionId, inputDelay, build })) {
    sendNet(message, true);
  }
  match = newMatch(0, inputDelay, sessionId);
  post({ type: "MATCH_STARTED", localPlayer: 0, inputDelay, kind: restart ? "restart" : "host" });
  startLoop();
}

/** Player 2: replace the local game with Player 1's and continue in lockstep. */
function joinMatch(sessionId: number, inputDelay: number, state: Uint8Array): void {
  const game = requireGame();
  checkOwnNvram(game); // keep the last own settings before switching machines
  settlePendingReset(game);
  game.loadState(state);
  ownCmos = false;
  match = newMatch(1, inputDelay, sessionId);
  audioPort?.postMessage({ type: "CLEAR" } satisfies AudioMessage);
  post({ type: "MATCH_STARTED", localPlayer: 1, inputDelay, kind: "join" });
  if (running) {
    pacer!.restart(performance.now());
  } else {
    startLoop();
  }
}

/** The opponent left: the game keeps running offline for whoever stayed. */
function stopMatch(): void {
  if (!match) {
    return;
  }
  match = null;
  post({ type: "MATCH_STOPPED" });
}

async function handle(command: GameCommand): Promise<void> {
  switch (command.type) {
    case "INIT":
      return init(command.coreUrl, command.canvas);
    case "LOAD_GAME":
      return loadGame(command.romsUrl, command.nvramUrl, command.savedNvram);
    case "SET_AUDIO":
      audioPort = command.port;
      return;
    case "START":
      return startLoop();
    case "PAUSE":
      requireOffline("Pausar");
      return stopLoop();
    case "STEP":
      requireOffline("Avançar frame");
      if (!running) {
        runFrames(1);
      }
      return;
    case "RESET":
      requireOffline("Reset");
      requireGame().reset();
      if (!running) {
        runFrames(1);
      }
      return;
    case "SET_INPUT":
      localButtons = command.buttons;
      return;
    case "SET_SYSTEM":
      systemSwitches = command.switches;
      return;
    case "SAVE_STATE":
      requireOffline("Salvar estado");
      savedState = { state: requireGame().saveState(), ownCmos };
      post({ type: "STATE_SAVED", bytes: savedState.state.length });
      return;
    case "LOAD_STATE":
      requireOffline("Carregar estado");
      if (!savedState) {
        throw new Error("no saved state");
      }
      requireGame().loadState(savedState.state);
      ownCmos = savedState.ownCmos;
      post({ type: "STATE_LOADED" });
      return;
    case "HOST_SYNC":
      return hostSync(command.sessionId, command.inputDelay, command.build, command.restart);
    case "MATCH_STOP":
      return stopMatch();
    case "NET_RECEIVE":
      return receiveNet(command.data);
  }
}

// Commands run one at a time, in arrival order: LOAD_GAME is sent right after
// INIT and must wait for the core to finish loading. A rejected command (e.g.
// "pause" during an online match) is reported without stopping the game.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<GameCommand>) => {
  queue = queue.then(() => handle(event.data)).catch(report);
};
