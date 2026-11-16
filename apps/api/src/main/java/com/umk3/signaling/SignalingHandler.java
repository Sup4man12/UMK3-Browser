package com.umk3.signaling;

import com.umk3.signaling.SignalingMessages.ClientMessage;
import com.umk3.signaling.SignalingMessages.ServerMessage;
import java.io.IOException;
import java.net.URI;
import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.util.UriComponentsBuilder;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/**
 * WebSocket endpoint /ws/signaling?room=&lt;id&gt;. JSON text frames carry
 * {@link ClientMessage}/{@link ServerMessage}; binary frames are relayed
 * verbatim to the other player (netplay fallback when WebRTC cannot connect).
 */
@Component
class SignalingHandler extends AbstractWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);
    private static final Pattern ROOM_NAME = Pattern.compile("[A-Za-z0-9_-]{1,32}");
    static final String DEFAULT_ROOM = "local";
    /** Largest netplay packet: a 16 KiB state-sync chunk plus its 12-byte header. */
    static final int MAX_RELAY_BYTES = 16 * 1024 + 64;
    static final int MAX_TEXT_BYTES = 64 * 1024;

    private final JsonMapper json;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final Map<String, Room> roomBySession = new ConcurrentHashMap<>();
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    SignalingHandler(JsonMapper json) {
        this.json = json;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) throws IOException {
        // Tomcat's default per-message buffers are 8 KiB: too small for SDP offers
        // with many candidates and for 16 KiB state-sync chunks.
        raw.setTextMessageSizeLimit(MAX_TEXT_BYTES);
        raw.setBinaryMessageSizeLimit(MAX_RELAY_BYTES);
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(raw, 2_000, 256 * 1024);
        String roomName = roomName(raw.getUri());
        if (roomName == null) {
            send(session, new ServerMessage.Error("Nome de sala inválido (use letras, números, - ou _)."));
            raw.close(CloseStatus.POLICY_VIOLATION);
            return;
        }

        Room room = rooms.computeIfAbsent(roomName, n -> new Room(n, this::nextSessionId));
        sessions.put(raw.getId(), session);
        List<Room.Delivery> deliveries = room.join(raw.getId());
        if (!room.isMember(raw.getId())) {
            deliver(deliveries);
            sessions.remove(raw.getId());
            raw.close(CloseStatus.NORMAL.withReason("room full"));
            return;
        }
        roomBySession.put(raw.getId(), room);
        log.info("session {} joined room {}", raw.getId(), roomName);
        deliver(deliveries);
    }

    @Override
    protected void handleTextMessage(WebSocketSession raw, TextMessage message) throws IOException {
        Room room = roomBySession.get(raw.getId());
        if (room == null) {
            return;
        }
        ClientMessage parsed;
        try {
            parsed = json.readValue(message.getPayload(), ClientMessage.class);
        } catch (JacksonException e) {
            send(sessions.get(raw.getId()), new ServerMessage.Error("Mensagem inválida: " + e.getOriginalMessage()));
            return;
        }

        switch (parsed) {
            case ClientMessage.Hello hello -> room.hello(raw.getId(), hello.build());
            case ClientMessage.Signal signal -> deliver(room.signal(raw.getId(), signal.payload()));
            case ClientMessage.Ready ready -> deliver(room.ready(raw.getId(), ready.ready(), ready.rttMs()));
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession raw, BinaryMessage message) throws IOException {
        Room room = roomBySession.get(raw.getId());
        if (room == null || message.getPayloadLength() > MAX_RELAY_BYTES) {
            return;
        }
        var target = room.other(raw.getId()).map(sessions::get);
        if (target.isPresent() && target.get().isOpen()) {
            target.get().sendMessage(new BinaryMessage(message.getPayload()));
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession raw, CloseStatus status) {
        sessions.remove(raw.getId());
        Room room = roomBySession.remove(raw.getId());
        if (room == null) {
            return;
        }
        log.info("session {} left room {} ({})", raw.getId(), room.name(), status);
        deliver(room.leave(raw.getId()));
        rooms.computeIfPresent(room.name(), (n, r) -> r.isEmpty() ? null : r);
    }

    static String roomName(URI uri) {
        if (uri == null) {
            return DEFAULT_ROOM;
        }
        String room = UriComponentsBuilder.fromUri(uri).build().getQueryParams().getFirst("room");
        if (room == null || room.isEmpty()) {
            return DEFAULT_ROOM;
        }
        return ROOM_NAME.matcher(room).matches() ? room : null;
    }

    private long nextSessionId() {
        // Fits the u32 sessionId of the binary netplay protocol; 0 is never used.
        return 1 + (random.nextLong() & 0x7fff_fffeL);
    }

    private void deliver(List<Room.Delivery> deliveries) {
        for (Room.Delivery d : deliveries) {
            send(sessions.get(d.to()), d.message());
        }
    }

    private void send(WebSocketSession session, ServerMessage message) {
        if (session == null || !session.isOpen()) {
            return;
        }
        try {
            session.sendMessage(new TextMessage(json.writeValueAsString(message)));
        } catch (IOException | RuntimeException e) {
            log.warn("failed to send {} to {}: {}", message.getClass().getSimpleName(), session.getId(), e.getMessage());
        }
    }
}
