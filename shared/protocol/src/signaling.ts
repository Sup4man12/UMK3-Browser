/**
 * JSON messages over the signaling WebSocket (/ws/signaling?room=<id>).
 * Mirrored by the Java records in apps/api (com.umk3.signaling.SignalingMessages).
 *
 * The server owns the room: players are numbered by arrival order (first =
 * player 0 / "Player 1", second = player 1 / "Player 2"); when Player 1 leaves,
 * Player 2 becomes Player 1. A third connection is refused.
 *
 * Binary WebSocket frames are not JSON: the server relays them verbatim to the
 * other player (fallback transport for NetMessage when WebRTC cannot connect).
 */

export type PlayerSlot = 0 | 1;

/** Opaque WebRTC payload (RTCSessionDescriptionInit or RTCIceCandidateInit), relayed verbatim. */
export type SignalPayload =
  | { kind: "description"; description: { type: "offer" | "answer"; sdp: string } }
  | { kind: "candidate"; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } };

export type ClientMessage =
  /** First message: identifies the emulator build (both players must match). */
  | { type: "hello"; build: string }
  | { type: "signal"; payload: SignalPayload }
  /** Enter key toggles this. rttMs is the latest measured round trip to the peer. */
  | { type: "ready"; ready: boolean; rttMs: number | null };

export type ServerMessage =
  | { type: "welcome"; room: string; player: PlayerSlot; occupants: PlayerSlot[] }
  | { type: "room-full"; room: string }
  | { type: "peer-joined"; player: PlayerSlot }
  /** `you` is the receiver's slot after the departure (Player 2 is promoted to Player 1). */
  | { type: "peer-left"; player: PlayerSlot; you: PlayerSlot }
  | { type: "signal"; payload: SignalPayload }
  | { type: "ready-state"; ready: [boolean, boolean] }
  /** Both pressed Enter: Player 1 restarts its machine (with its own CMOS) and sends it to Player 2. */
  | { type: "match-start"; sessionId: number; inputDelay: number }
  | { type: "error"; message: string };
