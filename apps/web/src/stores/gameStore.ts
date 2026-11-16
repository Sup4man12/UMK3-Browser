import { create } from "zustand";
import { DEFAULT_BINDINGS, type KeyBindings } from "../game/InputManager";
import type { CmosSource, GameEvent, RuntimeStats } from "../game/messages";
import type { SlotReport } from "../game/rom/romset";
import type { NetplayState, NotificationKind } from "../net/NetplayClient";

export type GamePhase =
  | "loading-core" // worker is fetching/instantiating the WASM core
  | "loading-roms" // downloading and verifying data/roms
  | "roms-missing" // the ROM set in data/roms is incomplete
  | "paused"
  | "running"
  | "fatal"; // the core or the ROMs could not be loaded

export interface Notification {
  id: number;
  kind: NotificationKind;
  text: string;
  at: number;
}

const MAX_NOTIFICATIONS = 30;
// v2: a single binding set for the local player (v1 stored one per player).
const BINDINGS_KEY = "umk3.keyBindings.v2";

interface GameState {
  phase: GamePhase;
  driverName: string | null;
  romReport: SlotReport[] | null;
  video: { width: number; height: number; fps: number } | null;
  /** Where the CMOS came from at boot. */
  cmos: CmosSource | null;
  /** Last time this player's CMOS was saved in the browser. */
  cmosSavedAt: number | null;
  stats: RuntimeStats | null;
  savedStateBytes: number | null;
  audioEnabled: boolean;
  netplay: NetplayState | null;
  /** Newest first. */
  notifications: Notification[];
  bindings: KeyBindings;

  applyEvent(event: GameEvent): void;
  setAudioEnabled(): void;
  setCmosSaved(): void;
  setNetplay(state: NetplayState): void;
  notify(kind: NotificationKind, text: string): void;
  setBindings(bindings: KeyBindings): void;
}

function loadBindings(): KeyBindings {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as KeyBindings;
      }
    }
  } catch {
    // Storage blocked or corrupted: fall back to defaults.
  }
  return DEFAULT_BINDINGS;
}

let nextNotificationId = 1;

export const useGameStore = create<GameState>((set, get) => ({
  phase: "loading-core",
  driverName: null,
  romReport: null,
  video: null,
  cmos: null,
  cmosSavedAt: null,
  stats: null,
  savedStateBytes: null,
  audioEnabled: false,
  netplay: null,
  notifications: [],
  bindings: loadBindings(),

  applyEvent(event) {
    switch (event.type) {
      case "CORE_READY":
        set({ phase: "loading-roms", driverName: event.driverName });
        break;
      case "ROMS_CHECKED":
        set({ romReport: event.report, phase: event.complete ? "loading-roms" : "roms-missing" });
        break;
      case "GAME_STARTED":
        set({ phase: "paused", video: { width: event.width, height: event.height, fps: event.fps }, cmos: event.cmos });
        break;
      case "RUNNING":
        set({ phase: event.running ? "running" : "paused" });
        break;
      case "STATS":
        set({ stats: event.stats });
        break;
      case "STATE_SAVED":
        set({ savedStateBytes: event.bytes });
        break;
      case "ERROR": {
        const { phase } = get();
        if (phase === "loading-core" || phase === "loading-roms") {
          set({ phase: "fatal" });
        }
        get().notify("error", event.message);
        break;
      }
      default:
        break;
    }
  },

  setAudioEnabled() {
    set({ audioEnabled: true });
  },

  setCmosSaved() {
    set({ cmosSavedAt: Date.now() });
  },

  setNetplay(netplay) {
    set({ netplay });
  },

  notify(kind, text) {
    const notification = { id: nextNotificationId++, kind, text, at: Date.now() };
    set((state) => ({ notifications: [notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS) }));
  },

  setBindings(bindings) {
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings));
    } catch {
      // Not persisted; still applied for this session.
    }
    set({ bindings });
  },
}));
