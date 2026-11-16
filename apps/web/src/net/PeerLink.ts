import type { SignalPayload } from "@umk3/protocol";

/**
 * "p2p": WebRTC DataChannel open. "relay": WebRTC did not connect in time, so
 * packets go through the signaling server's binary relay (same contract, more
 * latency). Both peers decide independently; each accepts both paths.
 */
export type Transport = "connecting" | "p2p" | "relay";

/** STUN/TURN come later (coturn); two browsers on one machine only need host candidates. */
const ICE_SERVERS: RTCIceServer[] = [];
const P2P_TIMEOUT_MS = 5000;
/**
 * When the opponent closes the page, the DataChannel closes a few ms before the
 * server's "peer-left" arrives (which closes this link). Waiting avoids
 * announcing a relay fallback for a peer that is simply gone.
 */
const CHANNEL_CLOSE_GRACE_MS = 1500;

interface PeerLinkOptions {
  /** The initiator (Player 1) creates the DataChannel and the offer. */
  initiator: boolean;
  sendSignal(payload: SignalPayload): void;
  sendRelay(data: ArrayBuffer): void;
  onMessage(data: ArrayBuffer): void;
  onTransport(transport: Transport): void;
}

export class PeerLink {
  /** Null when the browser has WebRTC disabled (e.g. media.peerconnection.enabled=false). */
  private readonly pc: RTCPeerConnection | null;
  /** Inputs, pings and hashes: unordered, no retransmission (lockstep repairs losses). */
  private channel: RTCDataChannel | null = null;
  /** State sync: reliable and ordered. */
  private reliable: RTCDataChannel | null = null;
  private transport: Transport = "connecting";
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private readonly fallbackTimer: ReturnType<typeof setTimeout>;
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: PeerLinkOptions) {
    this.fallbackTimer = setTimeout(() => {
      if (this.transport === "connecting") {
        this.setTransport("relay");
      }
    }, typeof RTCPeerConnection === "undefined" ? 0 : P2P_TIMEOUT_MS);

    if (typeof RTCPeerConnection === "undefined") {
      this.pc = null;
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const { candidate, sdpMid, sdpMLineIndex } = event.candidate.toJSON();
        this.options.sendSignal({
          kind: "candidate",
          candidate: { candidate: candidate ?? "", sdpMid: sdpMid ?? null, sdpMLineIndex: sdpMLineIndex ?? null },
        });
      }
    };
    pc.ondatachannel = (event) => this.attachChannel(event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.setTransport("relay");
      }
    };

    if (options.initiator) {
      this.attachChannel(pc.createDataChannel("netplay", { ordered: false, maxRetransmits: 0 }));
      this.attachChannel(pc.createDataChannel("sync"));
      void this.createOffer(pc);
    }
  }

  get currentTransport(): Transport {
    return this.transport;
  }

  async handleSignal(payload: SignalPayload): Promise<void> {
    const pc = this.pc;
    if (this.closed || !pc) {
      return; // without WebRTC the peer's offer goes unanswered and it falls back to the relay too
    }
    if (payload.kind === "description") {
      await pc.setRemoteDescription(payload.description);
      for (const candidate of this.pendingCandidates.splice(0)) {
        await pc.addIceCandidate(candidate);
      }
      if (payload.description.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.options.sendSignal({ kind: "description", description: { type: "answer", sdp: answer.sdp ?? "" } });
      }
    } else if (pc.remoteDescription) {
      await pc.addIceCandidate(payload.candidate);
    } else {
      this.pendingCandidates.push(payload.candidate);
    }
  }

  /** Binary frame received through the signaling server's relay. */
  handleRelay(data: ArrayBuffer): void {
    if (this.closed) {
      return;
    }
    // The opponent is already talking through the relay (e.g. WebRTC is disabled on
    // their side, so no offer will come): no point waiting for the P2P timeout.
    if (this.transport === "connecting") {
      this.setTransport("relay");
    }
    this.options.onMessage(data);
  }

  send(data: ArrayBuffer): void {
    if (this.closed) {
      return;
    }
    if (this.channel?.readyState === "open") {
      this.channel.send(data);
    } else {
      this.options.sendRelay(data);
    }
  }

  /** Delivered exactly once and in order (the relay WebSocket is reliable too). */
  sendReliable(data: ArrayBuffer): void {
    if (this.closed) {
      return;
    }
    if (this.reliable?.readyState === "open") {
      this.reliable.send(data);
    } else {
      this.options.sendRelay(data);
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.fallbackTimer);
    if (this.closeGraceTimer !== null) {
      clearTimeout(this.closeGraceTimer);
    }
    this.channel?.close();
    this.reliable?.close();
    this.pc?.close();
  }

  private async createOffer(pc: RTCPeerConnection): Promise<void> {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.options.sendSignal({ kind: "description", description: { type: "offer", sdp: offer.sdp ?? "" } });
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label === "sync") {
      this.reliable = channel;
    } else {
      this.channel = channel;
    }
    channel.binaryType = "arraybuffer";
    // P2P only once both channels are open, so a state sync never starts on one path and ends on another.
    channel.onopen = () => {
      if (this.channel?.readyState === "open" && this.reliable?.readyState === "open") {
        this.setTransport("p2p");
      }
    };
    channel.onclose = () => {
      if (!this.closed && this.transport === "p2p") {
        this.closeGraceTimer = setTimeout(() => this.setTransport("relay"), CHANNEL_CLOSE_GRACE_MS);
      }
    };
    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) {
        this.options.onMessage(event.data);
      }
    };
  }

  private setTransport(transport: Transport): void {
    if (this.closed || this.transport === transport) {
      return;
    }
    this.transport = transport;
    if (transport !== "connecting") {
      clearTimeout(this.fallbackTimer);
    }
    this.options.onTransport(transport);
  }
}
