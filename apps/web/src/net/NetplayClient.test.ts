import { buildId, decodeNetMessage, encodeNetMessage, type ClientMessage, type ServerMessage } from "@umk3/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameCommand } from "../game/messages";
import {
  NetplayClient,
  type LinkFactoryOptions,
  type LinkLike,
  type NetplayState,
  type NotificationKind,
  type SocketLike,
} from "./NetplayClient";
import type { Transport } from "./PeerLink";

const BUILD = "691a063c63b2dc320bff3b003bfa20f4";

class FakeSocket implements SocketLike {
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  server(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  json(): ClientMessage[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as ClientMessage);
  }
}

class FakeLink implements LinkLike {
  currentTransport: Transport = "connecting";
  sent: ArrayBuffer[] = [];
  reliable: ArrayBuffer[] = [];
  closed = false;
  constructor(readonly options: LinkFactoryOptions) {}
  async handleSignal() {}
  handleRelay(data: ArrayBuffer) {
    this.options.onMessage(data);
  }
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  sendReliable(data: ArrayBuffer) {
    this.reliable.push(data);
  }
  close() {
    this.closed = true;
  }
  becomes(transport: Transport) {
    this.currentTransport = transport;
    this.options.onTransport(transport);
  }
}

function setup() {
  const socket = new FakeSocket();
  const links: FakeLink[] = [];
  const toWorker: GameCommand[] = [];
  const notes: [NotificationKind, string][] = [];
  let state: NetplayState | null = null;
  const client = new NetplayClient({
    url: "ws://x/ws/signaling?room=r",
    room: "r",
    build: BUILD,
    createSocket: () => socket,
    createLink: (o) => {
      const link = new FakeLink(o);
      links.push(link);
      return link;
    },
    sendToWorker: (c) => toWorker.push(c),
    onState: (s) => (state = s),
    notify: (k, t) => notes.push([k, t]),
    randomSessionId: () => 77,
  });
  client.connect();
  socket.open();
  const texts = () => notes.map(([, t]) => t);
  return { client, socket, links, toWorker, notes, texts, state: () => state! };
}

/** Player 1 alone, then Player 2 joins and the P2P link opens. */
function hostWithPeer() {
  const h = setup();
  h.socket.server({ type: "welcome", room: "r", player: 0, occupants: [0] });
  h.socket.server({ type: "peer-joined", player: 1 });
  h.links[0]!.becomes("p2p");
  return h;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("NetplayClient", () => {
  it("announces the build on connect and the assigned slot on welcome", () => {
    const { socket, texts, state } = setup();
    expect(socket.json()[0]).toEqual({ type: "hello", build: BUILD });
    socket.server({ type: "welcome", room: "r", player: 0, occupants: [0] });
    expect(state().player).toBe(0);
    expect(texts()).toEqual([
      'Você entrou na sala "r" como Player 1.',
      "Aguardando Player 2. Compartilhe o endereço desta página.",
    ]);
  });

  it("Player 1 opens the peer link when Player 2 joins; Player 2 opens a passive one", () => {
    const p1 = setup();
    p1.socket.server({ type: "welcome", room: "r", player: 0, occupants: [0] });
    p1.socket.server({ type: "peer-joined", player: 1 });
    expect(p1.texts()).toContain("Player 2 entrou na sala.");
    expect(p1.links[0]!.options.initiator).toBe(true);

    const p2 = setup();
    p2.socket.server({ type: "welcome", room: "r", player: 1, occupants: [0, 1] });
    expect(p2.texts()).toContain("Player 1 já está na sala.");
    expect(p2.links).toHaveLength(1);
    expect(p2.links[0]!.options.initiator).toBe(false);
    p2.socket.server({ type: "signal", payload: { kind: "description", description: { type: "offer", sdp: "x" } } });
    expect(p2.links).toHaveLength(1);
  });

  it("Player 1 sends its running game as soon as the first RTT sample arrives, with no Enter", () => {
    const { links, toWorker, texts, state } = hostWithPeer();
    const link = links[0]!;
    expect(toWorker.some((c) => c.type === "HOST_SYNC")).toBe(false);

    // The ping sent on connect comes back after 20 ms.
    const ping = decodeNetMessage(link.sent.at(-1)!);
    expect(ping.type).toBe("ping");
    link.options.onMessage(
      encodeNetMessage({ type: "pong", id: (ping as { id: number }).id, sentAt: performance.now() - 20 }),
    );

    expect(toWorker.at(-1)).toEqual({
      type: "HOST_SYNC",
      sessionId: 77,
      inputDelay: 2,
      build: buildId(BUILD),
      restart: false,
    });
    expect(texts()).toContain("Enviando o jogo em andamento para o Player 2…");
    expect(state().syncing).toBe(true);
  });

  it("Player 1 does not wait forever for the RTT", () => {
    const { toWorker } = hostWithPeer();
    vi.advanceTimersByTime(1000);
    expect(toWorker.at(-1)).toMatchObject({ type: "HOST_SYNC", inputDelay: 3 }); // no RTT: default delay
  });

  it("sends state-sync messages over the reliable path and inputs over the fast one", () => {
    const { client, links } = hostWithPeer();
    const data = new ArrayBuffer(4);
    client.handleWorkerEvent({ type: "NET_SEND", data, reliable: true });
    client.handleWorkerEvent({ type: "NET_SEND", data, reliable: false });
    expect(links[0]!.reliable).toEqual([data]);
    expect(links[0]!.sent.at(-1)).toBe(data);
  });

  it("notifies both sides through the sync", () => {
    const host = hostWithPeer();
    vi.advanceTimersByTime(1000);
    host.client.handleWorkerEvent({ type: "MATCH_STARTED", localPlayer: 0, inputDelay: 2, kind: "host" });
    host.client.handleWorkerEvent({ type: "PEER_SYNCED" });
    expect(host.texts().at(-1)).toBe("Player 2 sincronizado: vocês já estão jogando juntos (delay de 2 frames).");
    expect(host.state()).toMatchObject({ inMatch: true, syncing: false });

    const joiner = setup();
    joiner.socket.server({ type: "welcome", room: "r", player: 1, occupants: [0, 1] });
    joiner.links[0]!.becomes("p2p");
    expect(joiner.texts()).toContain("Conectado ao Player 1. Aguardando o jogo dele…");
    const begin = encodeNetMessage({
      type: "sync-begin",
      sessionId: 77,
      inputDelay: 2,
      build: buildId(BUILD),
      packedBytes: 70_000,
      stateBytes: 2_455_552,
      stateHash: 1,
    });
    joiner.links[0]!.options.onMessage(begin);
    expect(joiner.toWorker.at(-1)).toMatchObject({ type: "NET_RECEIVE" });
    expect(joiner.texts().at(-1)).toBe("Sincronizando com o jogo do Player 1 (69 KB)…");
    joiner.client.handleWorkerEvent({ type: "MATCH_STARTED", localPlayer: 1, inputDelay: 2, kind: "join" });
    expect(joiner.texts().at(-1)).toBe("Sincronizado com o jogo do Player 1! Você é o Player 2 (delay de 2 frames).");
  });

  it("refuses Player 1's game when the emulator builds differ", () => {
    const joiner = setup();
    joiner.socket.server({ type: "welcome", room: "r", player: 1, occupants: [0, 1] });
    joiner.links[0]!.becomes("relay");
    const before = joiner.toWorker.length;
    joiner.links[0]!.options.onMessage(
      encodeNetMessage({ type: "sync-begin", sessionId: 1, inputDelay: 2, build: 0xdead, packedBytes: 1, stateBytes: 1, stateHash: 0 }),
    );
    expect(joiner.toWorker.length).toBe(before);
    expect(joiner.notes.at(-1)![0]).toBe("error");
  });

  it("on desync Player 1 resends its game automatically", () => {
    const { client, toWorker, texts } = hostWithPeer();
    vi.advanceTimersByTime(1000);
    client.handleWorkerEvent({ type: "MATCH_STARTED", localPlayer: 0, inputDelay: 2, kind: "host" });
    const syncs = () => toWorker.filter((c) => c.type === "HOST_SYNC").length;
    expect(syncs()).toBe(1);
    client.handleWorkerEvent({ type: "DESYNC", frame: 240 });
    expect(syncs()).toBe(2);
    expect(texts()).toContain("Dessincronização no frame 240: reenviando o jogo ao Player 2…");
  });

  it("Enter by both: Player 2 waits for Player 1's restarted game (Player 2 never restarts its own CMOS)", () => {
    const { client, socket, links, texts, toWorker, state } = setup();
    socket.server({ type: "welcome", room: "r", player: 1, occupants: [0, 1] });
    client.pressEnter();
    expect(texts()).toContain("Ainda conectando ao adversário, aguarde um instante.");

    links[0]!.becomes("p2p");
    socket.server({ type: "ready-state", ready: [true, false] });
    expect(texts()).toContain("Player 1 quer reiniciar do zero: pressione Enter para confirmar.");
    client.pressEnter();
    expect(socket.json().at(-1)).toMatchObject({ type: "ready", ready: true });

    const sentBefore = toWorker.length;
    socket.server({ type: "match-start", sessionId: 5, inputDelay: 2 });
    expect(toWorker.length).toBe(sentBefore); // nothing restarts locally
    expect(state().syncing).toBe(true);
    expect(texts().at(-1)).toBe("Reiniciando: aguardando o jogo do Player 1…");
    client.handleWorkerEvent({ type: "MATCH_STARTED", localPlayer: 1, inputDelay: 2, kind: "join" });
    expect(texts().at(-1)).toBe("Partida reiniciada do zero! Você é o Player 2.");
  });

  it("Enter by both: Player 1 restarts its own machine and sends it", () => {
    const { client, socket, toWorker, texts } = hostWithPeer();
    vi.advanceTimersByTime(1000);
    client.handleWorkerEvent({ type: "MATCH_STARTED", localPlayer: 0, inputDelay: 2, kind: "host" });
    toWorker.length = 0;
    socket.server({ type: "match-start", sessionId: 9, inputDelay: 3 }); // both pressed Enter
    expect(toWorker).toEqual([{ type: "HOST_SYNC", sessionId: 9, inputDelay: 3, build: buildId(BUILD), restart: true }]);
    client.handleWorkerEvent({ type: "MATCH_STARTED", localPlayer: 0, inputDelay: 3, kind: "restart" });
    expect(texts().at(-1)).toBe("Partida reiniciada do zero! Você é o Player 1.");
  });

  it("when Player 1 leaves: the game keeps running offline and Player 2 is promoted", () => {
    const { client, socket, links, texts, toWorker, state } = setup();
    socket.server({ type: "welcome", room: "r", player: 1, occupants: [0, 1] });
    links[0]!.becomes("p2p");
    client.handleWorkerEvent({ type: "MATCH_STARTED", localPlayer: 1, inputDelay: 2, kind: "join" });

    socket.server({ type: "peer-left", player: 0, you: 0 });
    expect(links[0]!.closed).toBe(true);
    expect(toWorker.at(-1)).toEqual({ type: "MATCH_STOP" });
    expect(state().player).toBe(0);
    expect(texts().slice(-4)).toEqual([
      "Player 1 saiu da sala.",
      "O jogo continua rodando offline; quem entrar agora entra nele.",
      "Agora você é o Player 1.",
      "Aguardando Player 2 entrar na sala.",
    ]);
  });

  it("answers pings and forwards game packets to the worker", () => {
    const { socket, links, toWorker } = hostWithPeer();
    const link = links[0]!;
    link.options.onMessage(encodeNetMessage({ type: "ping", id: 3, sentAt: 1.5 }));
    expect(decodeNetMessage(link.sent.at(-1)!)).toEqual({ type: "pong", id: 3, sentAt: 1.5 });

    link.options.onMessage(encodeNetMessage({ type: "input", sessionId: 1, player: 1, ack: 0, firstFrame: 2, buttons: [1] }));
    expect(toWorker.at(-1)).toMatchObject({ type: "NET_RECEIVE" });

    // Relay frames from the server reach the same path.
    socket.onmessage?.({ data: encodeNetMessage({ type: "ping", id: 9, sentAt: 0 }) } as MessageEvent);
    expect(decodeNetMessage(link.sent.at(-1)!)).toMatchObject({ type: "pong", id: 9 });
  });

  it("reports a room that is full and a server that is down", () => {
    const full = setup();
    full.socket.server({ type: "room-full", room: "r" });
    expect(full.state().connection).toBe("room-full");

    const down = setup();
    down.socket.close();
    expect(down.state().connection).toBe("offline");
    expect(down.texts().at(-1)).toBe("Servidor online indisponível (inicie apps/api). Jogando offline.");
  });
});
