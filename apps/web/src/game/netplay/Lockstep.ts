import { MAX_INPUTS_PER_PACKET, NO_FRAME, type NetMessage } from "@umk3/protocol";

type InputMessage = Extract<NetMessage, { type: "input" }>;

/**
 * Delay-based lockstep for two players. Pure logic (no timers, no I/O) so it
 * can be tested with a simulated network and real emulator cores.
 *
 * - The local input sampled while frame F is about to run is scheduled for
 *   frame F + inputDelay. Frames 0..inputDelay-1 use "no buttons" for both.
 * - Frame F may run only once both players' inputs for F are known.
 * - Every outgoing packet carries all local inputs the peer has not yet
 *   acknowledged (up to 64), so a lost packet is repaired by the next one
 *   without retransmission. Packets also acknowledge the peer's inputs.
 */
export class Lockstep {
  readonly localPlayer: 0 | 1;
  readonly inputDelay: number;
  readonly sessionId: number;

  /** Local inputs, dense from frame 0. */
  private readonly local: number[] = [];
  /** Remote inputs received contiguously from frame 0. */
  private readonly remote: number[] = [];
  /** Highest local frame the peer confirmed it has. */
  private peerHasLocalUpTo: number;

  constructor(options: { localPlayer: 0 | 1; inputDelay: number; sessionId: number }) {
    if (!Number.isInteger(options.inputDelay) || options.inputDelay < 1 || options.inputDelay > 32) {
      throw new RangeError(`invalid input delay ${options.inputDelay}`);
    }
    this.localPlayer = options.localPlayer;
    this.inputDelay = options.inputDelay;
    this.sessionId = options.sessionId;
    for (let f = 0; f < options.inputDelay; f++) {
      this.local.push(0);
      this.remote.push(0);
    }
    // The peer pre-fills the same empty frames.
    this.peerHasLocalUpTo = options.inputDelay - 1;
  }

  /** Number of frames with a known remote input (the next missing remote frame). */
  get remoteFrames(): number {
    return this.remote.length;
  }

  /**
   * Schedules the local input for frame `frame + inputDelay`, where `frame` is
   * the frame about to run. Idempotent per frame: calling it again while
   * stalled on the same frame keeps the first sample.
   */
  pushLocal(frame: number, buttons: number): void {
    if (this.local.length === frame + this.inputDelay) {
      this.local.push(buttons);
    } else if (this.local.length < frame + this.inputDelay) {
      throw new Error(`local input for frame ${frame + this.inputDelay} skipped a frame`);
    }
  }

  canRun(frame: number): boolean {
    return frame < this.local.length && frame < this.remote.length;
  }

  /** Buttons of [player 0, player 1] for a frame that canRun(). */
  inputs(frame: number): [number, number] {
    if (!this.canRun(frame)) {
      throw new Error(`inputs for frame ${frame} are not complete`);
    }
    const local = this.local[frame]!;
    const remote = this.remote[frame]!;
    return this.localPlayer === 0 ? [local, remote] : [remote, local];
  }

  /** The packet to send now: unacknowledged local inputs plus our ack. */
  outgoing(): InputMessage | null {
    const first = this.peerHasLocalUpTo + 1;
    if (first >= this.local.length) {
      return null;
    }
    const last = Math.min(this.local.length, first + MAX_INPUTS_PER_PACKET);
    return {
      type: "input",
      sessionId: this.sessionId,
      player: this.localPlayer,
      ack: this.remote.length > 0 ? this.remote.length - 1 : NO_FRAME,
      firstFrame: first,
      buttons: this.local.slice(first, last),
    };
  }

  /** Returns false when the packet does not belong to this match. */
  receive(message: InputMessage): boolean {
    if (message.sessionId !== this.sessionId || message.player === this.localPlayer) {
      return false;
    }
    if (message.ack !== NO_FRAME && message.ack > this.peerHasLocalUpTo) {
      this.peerHasLocalUpTo = Math.min(message.ack, this.local.length - 1);
    }
    message.buttons.forEach((buttons, i) => {
      // Only contiguous frames are kept; gaps are filled by later packets.
      if (message.firstFrame + i === this.remote.length) {
        this.remote.push(buttons);
      }
    });
    return true;
  }
}
