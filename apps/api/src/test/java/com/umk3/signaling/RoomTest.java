package com.umk3.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.umk3.signaling.SignalingMessages.ServerMessage;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;

class RoomTest {

    private final Room room = new Room("r", () -> 42L);

    private static List<ServerMessage> to(List<Room.Delivery> deliveries, String id) {
        return deliveries.stream().filter(d -> d.to().equals(id)).map(Room.Delivery::message).toList();
    }

    @Test
    void playersAreNumberedByArrivalOrder() {
        List<Room.Delivery> first = room.join("a");
        assertThat(to(first, "a")).first().isEqualTo(new ServerMessage.Welcome("r", 0, List.of(0)));

        List<Room.Delivery> second = room.join("b");
        assertThat(to(second, "b")).first().isEqualTo(new ServerMessage.Welcome("r", 1, List.of(0, 1)));
        assertThat(to(second, "a")).contains(new ServerMessage.PeerJoined(1));
    }

    @Test
    void thirdConnectionIsRefused() {
        room.join("a");
        room.join("b");
        assertThat(room.join("c")).containsExactly(new Room.Delivery("c", new ServerMessage.RoomFull("r")));
        assertThat(room.isMember("c")).isFalse();
    }

    @Test
    void whenPlayerOneLeavesPlayerTwoIsPromotedAndNewcomerIsPlayerTwo() {
        room.join("a");
        room.join("b");

        List<Room.Delivery> left = room.leave("a");
        assertThat(to(left, "b")).contains(new ServerMessage.PeerLeft(0, 0));

        List<Room.Delivery> joined = room.join("c");
        assertThat(to(joined, "c")).first().isEqualTo(new ServerMessage.Welcome("r", 1, List.of(0, 1)));
        assertThat(to(joined, "b")).contains(new ServerMessage.PeerJoined(1));
    }

    @Test
    void whenPlayerTwoLeavesPlayerOneKeepsSlot() {
        room.join("a");
        room.join("b");
        assertThat(to(room.leave("b"), "a")).contains(new ServerMessage.PeerLeft(1, 0));
    }

    @Test
    void matchStartsOnlyWhenBothAreReadyWithTheSameBuild() {
        room.join("a");
        room.join("b");
        room.hello("a", "build-1");
        room.hello("b", "build-1");

        List<Room.Delivery> oneReady = room.ready("a", true, 4.0);
        assertThat(to(oneReady, "b")).containsExactly(new ServerMessage.ReadyState(List.of(true, false)));

        List<Room.Delivery> bothReady = room.ready("b", true, 10.0);
        ServerMessage start = new ServerMessage.MatchStart(42L, InputDelayPolicy.forRoundTrip(10.0));
        assertThat(bothReady).containsExactlyInAnyOrder(new Room.Delivery("a", start), new Room.Delivery("b", start));

        // Ready flags reset after the start: a restart needs both to press Enter again.
        assertThat(to(room.ready("a", true, null), "a"))
            .containsExactly(new ServerMessage.ReadyState(List.of(true, false)));
    }

    @Test
    void differentBuildsCannotStart() {
        room.join("a");
        room.join("b");
        room.hello("a", "build-1");
        room.hello("b", "build-2");
        room.ready("a", true, null);
        List<Room.Delivery> out = room.ready("b", true, null);
        assertThat(to(out, "a")).first().isInstanceOf(ServerMessage.Error.class);
        assertThat(to(out, "a")).doesNotHaveAnyElementsOfTypes(ServerMessage.MatchStart.class);
    }

    @Test
    void joinAndLeaveResetReadiness() {
        room.join("a");
        room.ready("a", true, null);
        assertThat(to(room.join("b"), "a")).contains(new ServerMessage.ReadyState(List.of(false, false)));
    }

    @Test
    void signalsAndRelayGoToTheOtherPlayerOnly() {
        room.join("a");
        assertThat(room.signal("a", JsonNodeFactory.instance.objectNode())).isEmpty();
        assertThat(room.other("a")).isEmpty();

        room.join("b");
        assertThat(room.signal("a", JsonNodeFactory.instance.objectNode()))
            .singleElement().extracting(Room.Delivery::to).isEqualTo("b");
        assertThat(room.other("b")).contains("a");
        assertThat(room.other("stranger")).isEmpty();
    }

    @Test
    void inputDelayFollowsRoundTrip() {
        assertThat(InputDelayPolicy.forRoundTrip(null)).isEqualTo(InputDelayPolicy.DEFAULT_DELAY);
        assertThat(InputDelayPolicy.forRoundTrip(1.0)).isEqualTo(InputDelayPolicy.MIN_DELAY);
        // 100 ms RTT -> 50 ms one way -> 3 frames of 18.28 ms + 1 margin.
        assertThat(InputDelayPolicy.forRoundTrip(100.0)).isEqualTo(4);
        assertThat(InputDelayPolicy.forRoundTrip(10_000.0)).isEqualTo(InputDelayPolicy.MAX_DELAY);
    }
}
