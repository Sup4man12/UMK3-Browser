import { NetplayClient, type NetplayState, type NotificationKind } from "../net/NetplayClient";
import { PeerLink } from "../net/PeerLink";
import workletUrl from "./audio/audio-worklet.ts?worker&url";
import { AUDIO_PROCESSOR_NAME } from "./audio/audio-protocol";
import { SystemSwitch } from "@umk3/protocol";
import { InputManager, isEditable, type KeyBindings } from "./InputManager";
import { CORE_SAMPLE_RATE, GAME_DRIVER, type GameCommand, type GameEvent } from "./messages";
import { NvramStore } from "./nvramStore";

export interface RuntimeCallbacks {
  onEvent(event: GameEvent): void;
  onAudioEnabled(): void;
  onNetplay(state: NetplayState): void;
  notify(kind: NotificationKind, text: string): void;
  /** The player's own CMOS was saved in this browser. */
  onCmosSaved(): void;
}

/** Test-menu (service mode) key, as in FBNeo and MAME. Offline only. */
export const TEST_MENU_KEY = "F2";
/** How long the on-screen "test menu" button holds the switch. */
const TEST_MENU_PULSE_MS = 200;

const BASE_URL = new URL(import.meta.env.BASE_URL, window.location.href);
const CORE_URL = new URL("emulator/fbneo_core.mjs", BASE_URL).href;
const BUILD_INFO_URL = new URL("emulator/build-info.json", BASE_URL).href;
/** Served by vite-plugin-local-data.ts (dev/preview servers only). */
const ROMS_URL = new URL("roms/", BASE_URL).href;
const NVRAM_URL = new URL("nvram/", BASE_URL).href;

/** Room from ?room=<name>; both browsers must open the same one. */
export function roomFromLocation(): string {
  return new URLSearchParams(window.location.search).get("room") || "local";
}

function signalingUrl(room: string): string {
  const url = new URL("/ws/signaling", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", room);
  return url.href;
}

/**
 * Main-thread facade over the GameWorker. React talks only to this class; the
 * emulator itself never runs on the UI thread.
 */
export class GameRuntime {
  private readonly worker: Worker;
  private readonly input: InputManager;
  private audioContext: AudioContext | null = null;
  private netplay: NetplayClient | null = null;
  private readonly nvramStore = new NvramStore();
  private cmosSaveWarned = false;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    bindings: KeyBindings,
    private readonly callbacks: RuntimeCallbacks,
  ) {
    this.worker = new Worker(new URL("./GameWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<GameEvent>) => this.handleEvent(event.data);
    this.worker.onerror = (event) =>
      this.callbacks.onEvent({ type: "ERROR", message: event.message || "GameWorker failed to load" });

    this.input = new InputManager(bindings, (buttons) => this.send({ type: "SET_INPUT", buttons }));
    this.input.attach(window);
    window.addEventListener("keydown", this.onTestKey);
    window.addEventListener("keyup", this.onTestKey);

    // Browsers only allow audio to start in response to a user gesture.
    window.addEventListener("pointerdown", this.enableAudio, { once: true });
    window.addEventListener("keydown", this.enableAudio, { once: true });

    const offscreen = canvas.transferControlToOffscreen();
    this.send({ type: "INIT", coreUrl: CORE_URL, canvas: offscreen }, [offscreen]);
    // The player's own CMOS (settings changed in the test menu, audits...) lives in this browser only.
    const saved = this.nvramStore.load(GAME_DRIVER);
    const savedNvram = saved ? (saved.buffer as ArrayBuffer) : null;
    this.send({ type: "LOAD_GAME", romsUrl: ROMS_URL, nvramUrl: NVRAM_URL, savedNvram }, savedNvram ? [savedNvram] : []);
  }

  /** Presses the cabinet's test button briefly: opens the test menu (UMK3+ settings). */
  openTestMenu(): void {
    this.send({ type: "SET_SYSTEM", switches: SystemSwitch.Diagnostics });
    setTimeout(() => this.send({ type: "SET_SYSTEM", switches: 0 }), TEST_MENU_PULSE_MS);
  }

  /** Forgets this browser's CMOS; the next page load uses data/nvram/umk3p.fs or factory settings. */
  forgetSavedCmos(): void {
    this.nvramStore.clear(GAME_DRIVER);
  }

  start(): void {
    this.send({ type: "START" });
  }

  pause(): void {
    this.send({ type: "PAUSE" });
  }

  step(): void {
    this.send({ type: "STEP" });
  }

  reset(): void {
    this.send({ type: "RESET" });
  }

  saveState(): void {
    this.send({ type: "SAVE_STATE" });
  }

  loadState(): void {
    this.send({ type: "LOAD_STATE" });
  }

  setBindings(bindings: KeyBindings): void {
    this.input.setBindings(bindings);
  }

  dispose(): void {
    this.disposed = true;
    this.removeAudioListeners();
    this.input.detach();
    window.removeEventListener("keydown", this.onTestKey);
    window.removeEventListener("keyup", this.onTestKey);
    if (this.netplay) {
      window.removeEventListener("keydown", this.netplay.onKeyDown);
      this.netplay.dispose();
    }
    this.worker.terminate();
    void this.audioContext?.close();
  }

  private handleEvent(event: GameEvent): void {
    this.netplay?.handleWorkerEvent(event);
    if (event.type === "NET_SEND") {
      return;
    }
    if (event.type === "NVRAM_CHANGED") {
      if (this.nvramStore.save(GAME_DRIVER, new Uint8Array(event.data))) {
        this.callbacks.onCmosSaved();
      } else if (!this.cmosSaveWarned) {
        this.cmosSaveWarned = true;
        this.callbacks.notify("warning", "O navegador não permitiu salvar a CMOS (armazenamento local bloqueado ou cheio).");
      }
      return;
    }
    if (event.type === "GAME_STARTED") {
      void this.connectNetplay();
    }
    this.callbacks.onEvent(event);
  }

  /** Joins the online room once the emulator is ready to play. */
  private async connectNetplay(): Promise<void> {
    let build = "unknown";
    try {
      const info = (await (await fetch(BUILD_INFO_URL, { cache: "no-store" })).json()) as { wasmSha256?: string };
      build = info.wasmSha256 ?? build;
    } catch {
      this.callbacks.notify("warning", "build-info.json indisponível: o servidor não poderá comparar as versões.");
    }
    if (this.disposed) {
      return;
    }

    const room = roomFromLocation();
    this.netplay = new NetplayClient({
      url: signalingUrl(room),
      room,
      build,
      createSocket: (url) => new WebSocket(url),
      createLink: (options) => new PeerLink(options),
      sendToWorker: (command, transfer) => this.send(command, transfer),
      onState: (state) => this.callbacks.onNetplay(state),
      notify: (kind, text) => this.callbacks.notify(kind, text),
    });
    window.addEventListener("keydown", this.netplay.onKeyDown);
    this.netplay.connect();
  }

  private readonly onTestKey = (event: KeyboardEvent): void => {
    if (event.code !== TEST_MENU_KEY || event.repeat || isEditable(event.target)) {
      return;
    }
    event.preventDefault();
    this.send({ type: "SET_SYSTEM", switches: event.type === "keydown" ? SystemSwitch.Diagnostics : 0 });
  };

  private send(command: GameCommand, transfer: Transferable[] = []): void {
    this.worker.postMessage(command, transfer);
  }

  private removeAudioListeners(): void {
    window.removeEventListener("pointerdown", this.enableAudio);
    window.removeEventListener("keydown", this.enableAudio);
  }

  private readonly enableAudio = (): void => {
    this.removeAudioListeners();
    if (this.audioContext) {
      return;
    }
    // Created and resumed synchronously, inside the gesture.
    const context = new AudioContext({ latencyHint: "interactive", sampleRate: CORE_SAMPLE_RATE });
    this.audioContext = context;
    void context.resume();
    void this.connectWorklet(context);
  };

  private async connectWorklet(context: AudioContext): Promise<void> {
    try {
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, AUDIO_PROCESSOR_NAME, {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });
      node.connect(context.destination);

      const channel = new MessageChannel();
      node.port.postMessage({ port: channel.port1 }, [channel.port1]);
      this.send({ type: "SET_AUDIO", port: channel.port2 }, [channel.port2]);
      this.callbacks.onAudioEnabled();
    } catch (error) {
      this.callbacks.notify(
        "warning",
        `Áudio indisponível, jogando sem som: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
