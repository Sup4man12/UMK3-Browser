import type { SlotReport } from "./rom/romset";

/** FBNeo short name of the game this app runs. */
export const GAME_DRIVER = "umk3p";

/**
 * Sample rate the core renders audio at. Fixed (instead of the device rate)
 * because the game starts before audio may be enabled; the AudioContext is
 * created at this rate and the browser resamples to the device.
 */
export const CORE_SAMPLE_RATE = 48_000;

/** Main thread -> GameWorker. Commands are processed strictly in order. */
export type GameCommand =
  | { type: "INIT"; coreUrl: string; canvas: OffscreenCanvas }
  /**
   * Downloads and verifies the ROMs, then boots. CMOS, in order of preference: `savedNvram`
   * (this player's, from the browser), `<nvramUrl><driver>.fs` (data/nvram/umk3p.fs), factory settings.
   */
  | { type: "LOAD_GAME"; romsUrl: string; nvramUrl: string; savedNvram: ArrayBuffer | null }
  /** Port connected to the AudioWorklet. Can arrive at any time. */
  | { type: "SET_AUDIO"; port: MessagePort }
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "RESET" }
  /** Advances exactly one frame while paused. */
  | { type: "STEP" }
  /** Local player's buttons (applied to its slot: Player 1 offline, the assigned slot online). */
  | { type: "SET_INPUT"; buttons: number }
  /** Cabinet switches (SystemSwitch bits, e.g. the test-menu button). Ignored during an online match. */
  | { type: "SET_SYSTEM"; switches: number }
  | { type: "SAVE_STATE" }
  | { type: "LOAD_STATE" }
  /**
   * Player 1: snapshot the running game, send it to Player 2 (reliable) and
   * continue in lockstep from that point. `build` identifies the core. With
   * `restart`, the game first restarts from Player 1's own boot snapshot (Enter
   * by both): Player 2 always plays on Player 1's machine and CMOS.
   */
  | { type: "HOST_SYNC"; sessionId: number; inputDelay: number; build: number; restart: boolean }
  /** The opponent left: leave lockstep and keep playing offline. */
  | { type: "MATCH_STOP" }
  /** Binary NetMessage received from the opponent. */
  | { type: "NET_RECEIVE"; data: ArrayBuffer };

export interface RuntimeStats {
  frame: number;
  /** Emulated frames per second measured over the last second. */
  fps: number;
  /** Mean wall-clock time of core_run_frame() in milliseconds. */
  emulationMsPerFrame: number;
  /** Frames dropped because the worker fell too far behind. */
  skippedFrames: number;
  /** Present during an online match. */
  match: {
    frame: number;
    /** Ticks in which the next frame could not run because the opponent's input was missing. */
    stalls: number;
    /** True if the last tick was blocked waiting for the opponent. */
    waiting: boolean;
  } | null;
}

export type CmosSource = "browser" | "file" | "factory";

/** GameWorker -> main thread. */
export type GameEvent =
  | { type: "CORE_READY"; driver: string; driverName: string }
  | { type: "ROMS_CHECKED"; report: SlotReport[]; complete: boolean }
  /** `cmos`: where the CMOS came from (this browser, data/nvram/umk3p.fs, or factory settings). */
  | { type: "GAME_STARTED"; width: number; height: number; fps: number; cmos: CmosSource }
  /**
   * The local player's own CMOS changed (settings, audits, high scores): save it in this browser.
   * Never sent while running someone else's machine (after joining Player 1's game).
   */
  | { type: "NVRAM_CHANGED"; data: ArrayBuffer }
  | { type: "RUNNING"; running: boolean }
  | { type: "STATS"; stats: RuntimeStats }
  | { type: "STATE_SAVED"; bytes: number }
  | { type: "STATE_LOADED" }
  /**
   * restart: Player 1 restarted its game and sent it (both pressed Enter).
   * host: Player 1 sent its running game. join: Player 2 loaded Player 1's game.
   */
  | { type: "MATCH_STARTED"; localPlayer: 0 | 1; inputDelay: number; kind: "restart" | "host" | "join" }
  /** Player 1 side: Player 2 loaded the state and its inputs are arriving. */
  | { type: "PEER_SYNCED" }
  | { type: "MATCH_STOPPED" }
  /** Binary NetMessage to send to the opponent; `reliable` for state-sync messages. */
  | { type: "NET_SEND"; data: ArrayBuffer; reliable: boolean }
  /** The two machines diverged (state hashes differ at this frame). */
  | { type: "DESYNC"; frame: number }
  | { type: "ERROR"; message: string };
