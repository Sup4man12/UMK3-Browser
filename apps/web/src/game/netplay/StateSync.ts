import { deflateSync, inflateSync } from "fflate";
import { MAX_SYNC_BYTES, SYNC_CHUNK_BYTES, type NetMessage } from "@umk3/protocol";
import { stateHash } from "../firstBoot";

type SyncBegin = Extract<NetMessage, { type: "sync-begin" }>;
type SyncChunk = Extract<NetMessage, { type: "sync-chunk" }>;

/**
 * Messages that transfer a machine state to the joining player: one
 * sync-begin followed by deflate-compressed chunks (the 2.4 MB UMK3 state
 * compresses to ~70 KB). Must be sent over a reliable path.
 */
export function packState(
  state: Uint8Array,
  options: { sessionId: number; inputDelay: number; build: number },
): NetMessage[] {
  const packed = deflateSync(state, { level: 1 });
  const messages: NetMessage[] = [
    {
      type: "sync-begin",
      sessionId: options.sessionId,
      inputDelay: options.inputDelay,
      build: options.build,
      packedBytes: packed.length,
      stateBytes: state.length,
      stateHash: stateHash(state),
    },
  ];
  for (let offset = 0; offset < packed.length; offset += SYNC_CHUNK_BYTES) {
    messages.push({
      type: "sync-chunk",
      sessionId: options.sessionId,
      offset,
      data: packed.subarray(offset, offset + SYNC_CHUNK_BYTES),
    });
  }
  return messages;
}

export type SyncResult =
  | { kind: "complete"; sessionId: number; inputDelay: number; state: Uint8Array }
  | { kind: "error"; sessionId: number; message: string };

interface Transfer {
  begin: SyncBegin;
  packed: Uint8Array;
  received: Set<number>;
  receivedBytes: number;
}

/**
 * Reassembles a state transfer. Independent of arrival order (a chunk may
 * arrive before its sync-begin when the transport switches from relay to
 * P2P mid-transfer) and of duplicates. A newer session replaces an older one.
 */
export class SyncReceiver {
  private transfer: Transfer | null = null;
  /** Chunks that arrived before their sync-begin, by session. */
  private early = new Map<number, SyncChunk[]>();
  private earlyBytes = 0;

  /** Session currently being received, if any. */
  get pendingSession(): number | null {
    return this.transfer?.begin.sessionId ?? null;
  }

  accept(message: SyncBegin | SyncChunk): SyncResult | null {
    if (message.type === "sync-begin") {
      this.transfer = {
        begin: message,
        packed: new Uint8Array(message.packedBytes),
        received: new Set(),
        receivedBytes: 0,
      };
      const early = this.early.get(message.sessionId) ?? [];
      this.early.clear();
      this.earlyBytes = 0;
      for (const chunk of early) {
        const result = this.addChunk(chunk);
        if (result) {
          return result; // finished (or failed): leftover duplicates are irrelevant
        }
      }
      return null;
    }

    if (this.transfer && message.sessionId === this.transfer.begin.sessionId) {
      return this.addChunk(message);
    }
    // Copy: the chunk may alias a transferable buffer.
    if (this.earlyBytes + message.data.length <= MAX_SYNC_BYTES) {
      const list = this.early.get(message.sessionId) ?? [];
      list.push({ ...message, data: message.data.slice() });
      this.early.set(message.sessionId, list);
      this.earlyBytes += message.data.length;
    }
    return null;
  }

  private addChunk(chunk: SyncChunk): SyncResult | null {
    const transfer = this.transfer!;
    const { begin } = transfer;
    if (transfer.received.has(chunk.offset)) {
      return null;
    }
    if (chunk.offset + chunk.data.length > begin.packedBytes) {
      this.transfer = null;
      return { kind: "error", sessionId: begin.sessionId, message: "pedaço do estado fora dos limites" };
    }
    transfer.packed.set(chunk.data, chunk.offset);
    transfer.received.add(chunk.offset);
    transfer.receivedBytes += chunk.data.length;
    if (transfer.receivedBytes < begin.packedBytes) {
      return null;
    }

    this.transfer = null;
    let state: Uint8Array;
    try {
      state = inflateSync(transfer.packed);
    } catch {
      return { kind: "error", sessionId: begin.sessionId, message: "estado recebido corrompido (descompressão)" };
    }
    if (state.length !== begin.stateBytes || stateHash(state) !== begin.stateHash) {
      return { kind: "error", sessionId: begin.sessionId, message: "estado recebido não confere com o hash" };
    }
    return { kind: "complete", sessionId: begin.sessionId, inputDelay: begin.inputDelay, state };
  }
}
