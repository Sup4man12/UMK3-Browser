import {
  buildId,
  decodeNetMessage,
  encodeNetMessage,
  inputDelayForRtt,
  NetMessageType,
  type ClientMessage,
  type PlayerSlot,
  type ServerMessage,
  type SignalPayload,
} from "@umk3/protocol";
import type { GameCommand, GameEvent } from "../game/messages";
import { isEditable } from "../game/InputManager";
import type { Transport } from "./PeerLink";

export type ConnectionState = "connecting" | "online" | "offline" | "room-full";

export interface NetplayState {
  connection: ConnectionState;
  room: string;
  /** Local slot (0 = Player 1), null until the server assigns one. */
  player: PlayerSlot | null;
  opponentPresent: boolean;
  ready: [boolean, boolean];
  transport: Transport | null;
  rttMs: number | null;
  inMatch: boolean;
  inputDelay: number | null;
  /** Player 1 is sending its game / Player 2 is loading it. */
  syncing: boolean;
}

export type NotificationKind = "info" | "success" | "warning" | "error";

/** Minimal WebSocket surface (lets tests inject a fake). */
export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export interface LinkLike {
  readonly currentTransport: Transport;
  handleSignal(payload: SignalPayload): Promise<void>;
  handleRelay(data: ArrayBuffer): void;
  send(data: ArrayBuffer): void;
  sendReliable(data: ArrayBuffer): void;
  close(): void;
}

export interface LinkFactoryOptions {
  initiator: boolean;
  sendSignal(payload: SignalPayload): void;
  sendRelay(data: ArrayBuffer): void;
  onMessage(data: ArrayBuffer): void;
  onTransport(transport: Transport): void;
}

export interface NetplayClientOptions {
  url: string;
  room: string;
  /** Emulator build (wasm SHA-256 hex): matches are only possible between identical builds. */
  build: string;
  createSocket(url: string): SocketLike;
  createLink(options: LinkFactoryOptions): LinkLike;
  sendToWorker(command: GameCommand, transfer?: Transferable[]): void;
  onState(state: NetplayState): void;
  notify(kind: NotificationKind, text: string): void;
  /** Random u32 session ids (injectable for tests). */
  randomSessionId?: () => number;
}

const PING_INTERVAL_MS = 1000;
/** Player 1 waits at most this long for a first RTT sample before sending its game. */
const RTT_WAIT_MS = 1000;

function cryptoSessionId(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]! || 1;
}
const OPEN = 1;

const label = (slot: PlayerSlot) => `Player ${slot + 1}`;
const other = (slot: PlayerSlot): PlayerSlot => (slot === 0 ? 1 : 0);

/**
 * Main-thread side of online play: room membership through the signaling
 * WebSocket, the peer transport, joining a game in progress (Player 1 sends
 * its running game to Player 2 as soon as they are connected), the optional
 * Enter "restart from scratch" handshake, RTT measurement and the
 * player-facing notifications. Emulation and lockstep run in the GameWorker;
 * this class only moves their packets.
 */
export class NetplayClient {
  private socket: SocketLike | null = null;
  private link: LinkLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingId = 0;
  private disposed = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Player 2: both pressed Enter and Player 1's restarted game is on its way. */
  private restartPending = false;
  /** Player 2: session ids already announced, to notify only once per transfer. */
  private announcedSync = new Set<number>();
  private state: NetplayState;

  constructor(private readonly options: NetplayClientOptions) {
    this.state = {
      connection: "connecting",
      room: options.room,
      player: null,
      opponentPresent: false,
      ready: [false, false],
      transport: null,
      rttMs: null,
      inMatch: false,
      inputDelay: null,
      syncing: false,
    };
  }

  connect(): void {
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => this.sendJson({ type: "hello", build: this.options.build });
    socket.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.link?.handleRelay(event.data);
      } else if (typeof event.data === "string") {
        this.handleServer(JSON.parse(event.data) as ServerMessage);
      }
    };
    socket.onclose = () => this.handleSocketClosed();
    this.publish();
  }

  /** Enter: toggles "ready". With both ready the server restarts the game from scratch on both sides. */
  pressEnter(): void {
    const { player, connection, opponentPresent } = this.state;
    if (connection !== "online" || player === null) {
      this.options.notify("warning", "Sem conexão com o servidor: o modo online não está disponível.");
      return;
    }
    if (!opponentPresent) {
      this.options.notify("info", `Aguardando ${label(other(player))} entrar na sala.`);
      return;
    }
    if (!this.link || this.link.currentTransport === "connecting") {
      this.options.notify("info", "Ainda conectando ao adversário, aguarde um instante.");
      return;
    }
    this.sendJson({ type: "ready", ready: !this.state.ready[player], rttMs: this.state.rttMs });
  }

  readonly onKeyDown = (event: KeyboardEvent): void => {
    if ((event.code === "Enter" || event.code === "NumpadEnter") && !event.repeat && !isEditable(event.target)) {
      event.preventDefault();
      this.pressEnter();
    }
  };

  /** Events from the GameWorker that concern the network. */
  handleWorkerEvent(event: GameEvent): void {
    switch (event.type) {
      case "NET_SEND":
        if (event.reliable) {
          this.link?.sendReliable(event.data);
        } else {
          this.link?.send(event.data);
        }
        break;
      case "MATCH_STARTED":
        this.state = { ...this.state, inMatch: true, inputDelay: event.inputDelay };
        if (event.kind === "join" && this.restartPending) {
          this.restartPending = false;
          this.state = { ...this.state, syncing: false };
          this.options.notify("success", "Partida reiniciada do zero! Você é o Player 2.");
        } else if (event.kind === "join") {
          this.state = { ...this.state, syncing: false };
          this.options.notify(
            "success",
            `Sincronizado com o jogo do Player 1! Você é o Player 2 (delay de ${event.inputDelay} frames).`,
          );
        } else if (event.kind === "restart") {
          this.options.notify("success", "Partida reiniciada do zero! Você é o Player 1.");
        }
        this.publish();
        break;
      case "PEER_SYNCED":
        this.state = { ...this.state, syncing: false };
        this.options.notify(
          "success",
          `Player 2 sincronizado: vocês já estão jogando juntos (delay de ${this.state.inputDelay} frames).`,
        );
        this.publish();
        break;
      case "MATCH_STOPPED":
        this.state = { ...this.state, inMatch: false, syncing: false };
        this.publish();
        break;
      case "DESYNC":
        if (this.state.player === 0) {
          this.options.notify("error", `Dessincronização no frame ${event.frame}: reenviando o jogo ao Player 2…`);
          this.startHostSync();
        } else {
          this.options.notify(
            "error",
            `Dessincronização no frame ${event.frame}: aguardando o Player 1 reenviar o jogo…`,
          );
        }
        break;
      default:
        break;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSyncTimer();
    this.stopPing();
    this.link?.close();
    this.link = null;
    this.socket?.close();
    this.socket = null;
  }

  private handleServer(message: ServerMessage): void {
    switch (message.type) {
      case "welcome": {
        const opponentPresent = message.occupants.length > 1;
        this.state = { ...this.state, connection: "online", player: message.player, opponentPresent, ready: [false, false] };
        this.options.notify("success", `Você entrou na sala "${message.room}" como ${label(message.player)}.`);
        if (opponentPresent) {
          this.options.notify("info", `${label(other(message.player))} já está na sala.`);
          // Player 2 waits for Player 1's offer, but has its own link (and timeout) from now
          // on, so it still reaches the relay if the offer never comes (e.g. WebRTC disabled there).
          this.openLink(false);
        } else {
          this.options.notify("info", `Aguardando ${label(other(message.player))}. Compartilhe o endereço desta página.`);
        }
        break;
      }
      case "room-full":
        this.state = { ...this.state, connection: "room-full" };
        this.options.notify("error", `A sala "${message.room}" já tem 2 jogadores. Você continua jogando offline.`);
        break;
      case "peer-joined":
        this.state = { ...this.state, opponentPresent: true, ready: [false, false] };
        this.options.notify("success", `${label(message.player)} entrou na sala.`);
        // Player 1 starts the WebRTC negotiation.
        if (this.state.player === 0) {
          this.openLink(true);
        }
        break;
      case "peer-left": {
        const previous = this.state.player;
        this.closeLink();
        this.state = {
          ...this.state,
          player: message.you,
          opponentPresent: false,
          ready: [false, false],
          rttMs: null,
          transport: null,
        };
        this.options.notify("warning", `${label(message.player)} saiu da sala.`);
        if (this.state.inMatch) {
          this.options.sendToWorker({ type: "MATCH_STOP" });
          this.options.notify("info", "O jogo continua rodando offline; quem entrar agora entra nele.");
        }
        this.state = { ...this.state, syncing: false };
        if (previous !== null && previous !== message.you) {
          this.options.notify("info", `Agora você é o ${label(message.you)}.`);
        }
        this.options.notify("info", `Aguardando ${label(other(message.you))} entrar na sala.`);
        break;
      }
      case "signal":
        if (!this.link) {
          this.openLink(false);
        }
        void this.link!.handleSignal(message.payload).catch((error: unknown) =>
          this.options.notify("error", `Falha na negociação WebRTC: ${String(error)}`),
        );
        break;
      case "ready-state":
        this.announceReadiness(message.ready);
        this.state = { ...this.state, ready: message.ready };
        break;
      case "match-start": {
        // Both pressed Enter: Player 1 restarts its own machine (with its own CMOS)
        // and sends it; Player 2 plays on it. CMOS settings are per player, so two
        // independent restarts would boot different machines.
        this.cancelSyncTimer();
        this.state = { ...this.state, ready: [false, false] };
        if (this.state.player === 0) {
          this.startHostSync({ sessionId: message.sessionId, inputDelay: message.inputDelay, restart: true });
        } else {
          this.restartPending = true;
          this.state = { ...this.state, syncing: true };
          this.options.notify("info", "Reiniciando: aguardando o jogo do Player 1…");
        }
        break;
      }
      case "error":
        this.options.notify("error", message.message);
        break;
    }
    this.publish();
  }

  private announceReadiness(next: [boolean, boolean]): void {
    const me = this.state.player;
    if (me === null) {
      return;
    }
    const action = "reiniciar do zero";
    const opponent = other(me);
    if (next[me] && !this.state.ready[me]) {
      this.options.notify("info", `Você está pronto. Aguardando ${label(opponent)} pressionar Enter.`);
    }
    if (!next[me] && this.state.ready[me]) {
      this.options.notify("info", "Você cancelou o pedido.");
    }
    if (next[opponent] && !this.state.ready[opponent]) {
      this.options.notify("warning", `${label(opponent)} quer ${action}: pressione Enter para confirmar.`);
    }
    if (!next[opponent] && this.state.ready[opponent]) {
      this.options.notify("info", `${label(opponent)} cancelou o pedido.`);
    }
  }

  private openLink(initiator: boolean): void {
    this.closeLink();
    this.state = { ...this.state, transport: "connecting" };
    this.link = this.options.createLink({
      initiator,
      sendSignal: (payload) => this.sendJson({ type: "signal", payload }),
      sendRelay: (data) => {
        if (this.socket?.readyState === OPEN) {
          this.socket.send(data);
        }
      },
      onMessage: (data) => this.handlePeerData(data),
      onTransport: (transport) => {
        this.state = { ...this.state, transport };
        if (transport === "p2p") {
          this.options.notify("success", "Conexão P2P (WebRTC) estabelecida com o adversário.");
        } else if (transport === "relay") {
          this.options.notify("warning", "Conexão P2P indisponível: usando o relay do servidor (mais latência).");
        }
        if (transport !== "connecting") {
          this.sendPing(); // measure RTT right away: it sizes the input delay
          if (this.state.player === 0 && !this.state.inMatch && this.syncTimer === null) {
            // Give the first RTT sample a moment, then send the running game.
            this.syncTimer = setTimeout(() => this.startHostSync(), RTT_WAIT_MS);
          } else if (this.state.player === 1 && !this.state.inMatch) {
            this.state = { ...this.state, syncing: true };
            this.options.notify("info", "Conectado ao Player 1. Aguardando o jogo dele…");
          }
        }
        this.publish();
      },
    });
    this.startPing();
  }

  /**
   * Player 1: send the running game to Player 2 and continue together from
   * there. With `restart`, the game first restarts from scratch (Enter by both).
   */
  private startHostSync(restart?: { sessionId: number; inputDelay: number; restart: true }): void {
    this.cancelSyncTimer();
    if (this.state.player !== 0 || !this.state.opponentPresent || !this.link) {
      return;
    }
    this.state = { ...this.state, syncing: true };
    this.options.sendToWorker({
      type: "HOST_SYNC",
      sessionId: restart?.sessionId ?? (this.options.randomSessionId ?? cryptoSessionId)(),
      inputDelay: restart?.inputDelay ?? inputDelayForRtt(this.state.rttMs),
      build: buildId(this.options.build),
      restart: restart !== undefined,
    });
    if (!restart) {
      this.options.notify("info", "Enviando o jogo em andamento para o Player 2…");
    }
    this.publish();
  }

  private cancelSyncTimer(): void {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private closeLink(): void {
    this.cancelSyncTimer();
    this.stopPing();
    this.link?.close();
    this.link = null;
  }

  private handlePeerData(data: ArrayBuffer): void {
    const type = new Uint8Array(data, 0, Math.min(2, data.byteLength))[1];
    if (type === NetMessageType.Ping || type === NetMessageType.Pong) {
      let message;
      try {
        message = decodeNetMessage(data);
      } catch {
        return;
      }
      if (message.type === "ping") {
        this.link?.send(encodeNetMessage({ type: "pong", id: message.id, sentAt: message.sentAt }));
      } else if (message.type === "pong") {
        const sample = performance.now() - message.sentAt;
        const first = this.state.rttMs === null;
        const rttMs = first ? sample : this.state.rttMs! * 0.8 + sample * 0.2;
        this.state = { ...this.state, rttMs };
        this.publish();
        if (first && this.syncTimer !== null) {
          this.startHostSync(); // got the RTT: no need to wait any longer
        }
      }
      return;
    }
    if (type === NetMessageType.SyncBegin && !this.acceptSyncBegin(data)) {
      return;
    }
    this.options.sendToWorker({ type: "NET_RECEIVE", data }, [data]);
  }

  /** Player 2: checks Player 1's build before loading its game. */
  private acceptSyncBegin(data: ArrayBuffer): boolean {
    let message;
    try {
      message = decodeNetMessage(data);
    } catch {
      return false;
    }
    if (message.type !== "sync-begin") {
      return false;
    }
    if (message.build !== buildId(this.options.build)) {
      this.options.notify(
        "error",
        "O Player 1 usa outra versão do emulador: não é possível sincronizar. Recarreguem a página nos dois computadores.",
      );
      return false;
    }
    if (!this.announcedSync.has(message.sessionId)) {
      this.announcedSync.add(message.sessionId);
      this.state = { ...this.state, syncing: true };
      this.options.notify(
        "info",
        `Sincronizando com o jogo do Player 1 (${Math.ceil(message.packedBytes / 1024)} KB)…`,
      );
      this.publish();
    }
    return true;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private sendPing(): void {
    // While negotiating, a ping would go through the relay and make the peer
    // conclude that the relay is the path in use.
    if (!this.link || this.link.currentTransport === "connecting") {
      return;
    }
    this.pingId = (this.pingId + 1) >>> 0;
    this.link?.send(encodeNetMessage({ type: "ping", id: this.pingId, sentAt: performance.now() }));
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleSocketClosed(): void {
    if (this.disposed) {
      return;
    }
    const wasOnline = this.state.connection === "online";
    this.closeLink();
    if (this.state.inMatch) {
      this.options.sendToWorker({ type: "MATCH_STOP" });
    }
    if (this.state.connection !== "room-full") {
      this.state = { ...this.state, connection: "offline", opponentPresent: false, transport: null, rttMs: null };
      this.options.notify(
        "error",
        wasOnline
          ? "Conexão com o servidor perdida. Recarregue a página para voltar ao modo online."
          : "Servidor online indisponível (inicie apps/api). Jogando offline.",
      );
    }
    this.publish();
  }

  private sendJson(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private publish(): void {
    this.options.onState({ ...this.state });
  }
}
