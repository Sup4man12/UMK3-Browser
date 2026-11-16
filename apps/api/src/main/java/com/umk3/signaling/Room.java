package com.umk3.signaling;

import com.umk3.signaling.SignalingMessages.ServerMessage;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.LongSupplier;
import tools.jackson.databind.JsonNode;

/**
 * Two-player room. Player slots follow arrival order: the first member is
 * player 0 ("Player 1"), the second is player 1 ("Player 2"). When player 0
 * leaves, player 1 is promoted, so whoever joins next is always Player 2.
 *
 * Pure state machine: every operation returns the messages to deliver, and the
 * WebSocket handler only transports them. All methods are synchronized because
 * both members' sockets may call in concurrently.
 */
final class Room {

    static final int CAPACITY = 2;

    record Delivery(String to, ServerMessage message) {
    }

    private static final class Member {
        final String id;
        String build;
        boolean ready;
        Double rttMs;

        Member(String id) {
            this.id = id;
        }
    }

    private final String name;
    private final LongSupplier sessionIds;
    private final List<Member> members = new ArrayList<>(CAPACITY);

    Room(String name, LongSupplier sessionIds) {
        this.name = name;
        this.sessionIds = sessionIds;
    }

    String name() {
        return name;
    }

    synchronized boolean isEmpty() {
        return members.isEmpty();
    }

    /** Returns RoomFull for the caller when the room has no free slot (the caller must not be kept). */
    synchronized List<Delivery> join(String id) {
        if (members.size() >= CAPACITY) {
            return List.of(new Delivery(id, new ServerMessage.RoomFull(name)));
        }
        members.add(new Member(id));
        resetReady();

        int player = members.size() - 1;
        List<Integer> occupants = new ArrayList<>();
        for (int i = 0; i < members.size(); i++) {
            occupants.add(i);
        }

        List<Delivery> out = new ArrayList<>();
        out.add(new Delivery(id, new ServerMessage.Welcome(name, player, occupants)));
        for (Member other : members) {
            if (!other.id.equals(id)) {
                out.add(new Delivery(other.id, new ServerMessage.PeerJoined(player)));
            }
        }
        out.addAll(broadcastReadyState());
        return out;
    }

    synchronized boolean isMember(String id) {
        return indexOf(id) >= 0;
    }

    synchronized List<Delivery> leave(String id) {
        int player = indexOf(id);
        if (player < 0) {
            return List.of();
        }
        members.remove(player);
        resetReady();

        List<Delivery> out = new ArrayList<>();
        for (int slot = 0; slot < members.size(); slot++) {
            out.add(new Delivery(members.get(slot).id, new ServerMessage.PeerLeft(player, slot)));
        }
        out.addAll(broadcastReadyState());
        return out;
    }

    synchronized void hello(String id, String build) {
        member(id).ifPresent(m -> m.build = build);
    }

    synchronized List<Delivery> signal(String id, JsonNode payload) {
        return other(id).map(o -> List.of(new Delivery(o, new ServerMessage.Signal(payload)))).orElse(List.of());
    }

    /** Recipient of a binary relay frame sent by {@code id}, if the other slot is occupied. */
    synchronized Optional<String> other(String id) {
        if (indexOf(id) < 0) {
            return Optional.empty();
        }
        return members.stream().map(m -> m.id).filter(m -> !m.equals(id)).findFirst();
    }

    synchronized List<Delivery> ready(String id, boolean ready, Double rttMs) {
        Optional<Member> member = member(id);
        if (member.isEmpty()) {
            return List.of();
        }
        member.get().ready = ready;
        if (rttMs != null) {
            member.get().rttMs = rttMs;
        }

        boolean bothReady = members.size() == CAPACITY && members.stream().allMatch(m -> m.ready);
        if (!bothReady) {
            return broadcastReadyState();
        }

        resetReady();
        List<Delivery> out = new ArrayList<>();
        Member first = members.get(0);
        Member second = members.get(1);
        if (first.build == null || !Objects.equals(first.build, second.build)) {
            for (Member m : members) {
                out.add(new Delivery(m.id, new ServerMessage.Error(
                    "Os dois jogadores precisam da mesma versão do emulador (recarreguem a página).")));
            }
            out.addAll(broadcastReadyState());
            return out;
        }

        Double worstRtt = members.stream()
            .map(m -> m.rttMs)
            .filter(Objects::nonNull)
            .max(Double::compare)
            .orElse(null);
        ServerMessage start = new ServerMessage.MatchStart(
            sessionIds.getAsLong(), InputDelayPolicy.forRoundTrip(worstRtt));
        for (Member m : members) {
            out.add(new Delivery(m.id, start));
        }
        return out;
    }

    private List<Delivery> broadcastReadyState() {
        List<Boolean> flags = new ArrayList<>(List.of(false, false));
        for (int i = 0; i < members.size(); i++) {
            flags.set(i, members.get(i).ready);
        }
        ServerMessage state = new ServerMessage.ReadyState(flags);
        return members.stream().map(m -> new Delivery(m.id, state)).toList();
    }

    private void resetReady() {
        members.forEach(m -> m.ready = false);
    }

    private int indexOf(String id) {
        for (int i = 0; i < members.size(); i++) {
            if (members.get(i).id.equals(id)) {
                return i;
            }
        }
        return -1;
    }

    private Optional<Member> member(String id) {
        int i = indexOf(id);
        return i < 0 ? Optional.empty() : Optional.of(members.get(i));
    }
}
