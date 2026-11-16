package com.umk3.signaling;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import java.util.List;
import tools.jackson.databind.JsonNode;

/**
 * JSON messages of the signaling WebSocket. Mirrors
 * shared/protocol/src/signaling.ts; keep both in sync.
 */
final class SignalingMessages {

    private SignalingMessages() {
    }

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
    @JsonSubTypes({
        @JsonSubTypes.Type(value = ClientMessage.Hello.class, name = "hello"),
        @JsonSubTypes.Type(value = ClientMessage.Signal.class, name = "signal"),
        @JsonSubTypes.Type(value = ClientMessage.Ready.class, name = "ready"),
    })
    sealed interface ClientMessage {

        /** @param build emulator build id (wasm SHA-256); both players must match */
        record Hello(String build) implements ClientMessage {
        }

        /** WebRTC offer/answer/candidate, relayed verbatim to the other player. */
        record Signal(JsonNode payload) implements ClientMessage {
        }

        record Ready(boolean ready, Double rttMs) implements ClientMessage {
        }
    }

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
    @JsonSubTypes({
        @JsonSubTypes.Type(value = ServerMessage.Welcome.class, name = "welcome"),
        @JsonSubTypes.Type(value = ServerMessage.RoomFull.class, name = "room-full"),
        @JsonSubTypes.Type(value = ServerMessage.PeerJoined.class, name = "peer-joined"),
        @JsonSubTypes.Type(value = ServerMessage.PeerLeft.class, name = "peer-left"),
        @JsonSubTypes.Type(value = ServerMessage.Signal.class, name = "signal"),
        @JsonSubTypes.Type(value = ServerMessage.ReadyState.class, name = "ready-state"),
        @JsonSubTypes.Type(value = ServerMessage.MatchStart.class, name = "match-start"),
        @JsonSubTypes.Type(value = ServerMessage.Error.class, name = "error"),
    })
    sealed interface ServerMessage {

        record Welcome(String room, int player, List<Integer> occupants) implements ServerMessage {
        }

        record RoomFull(String room) implements ServerMessage {
        }

        record PeerJoined(int player) implements ServerMessage {
        }

        /** @param you the receiver's slot after the departure (Player 2 is promoted) */
        record PeerLeft(int player, int you) implements ServerMessage {
        }

        record Signal(JsonNode payload) implements ServerMessage {
        }

        record ReadyState(List<Boolean> ready) implements ServerMessage {
        }

        record MatchStart(long sessionId, int inputDelay) implements ServerMessage {
        }

        record Error(String message) implements ServerMessage {
        }
    }
}
