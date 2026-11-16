package com.umk3.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.websocket.ContainerProvider;
import jakarta.websocket.WebSocketContainer;
import java.net.URI;
import java.nio.ByteBuffer;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

/** Runs the real server and talks to it with real WebSocket clients. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SignalingWebSocketTest {

    @LocalServerPort
    int port;

    private static final class Client extends AbstractWebSocketHandler {
        final BlockingQueue<String> texts = new LinkedBlockingQueue<>();
        final BlockingQueue<ByteBuffer> binaries = new LinkedBlockingQueue<>();
        WebSocketSession session;

        @Override
        protected void handleTextMessage(WebSocketSession s, TextMessage m) {
            texts.add(m.getPayload());
        }

        @Override
        protected void handleBinaryMessage(WebSocketSession s, BinaryMessage m) {
            binaries.add(m.getPayload());
        }

        String next() throws InterruptedException {
            String m = texts.poll(5, TimeUnit.SECONDS);
            assertThat(m).as("expected a message").isNotNull();
            return m;
        }

        /** Skips ready-state broadcasts and returns the next message of another type. */
        String nextIgnoringReadyState() throws InterruptedException {
            String m;
            do {
                m = next();
            } while (m.contains("\"ready-state\""));
            return m;
        }
    }

    private Client connect(String room) throws Exception {
        return connect(room, "http://localhost:5173");
    }

    private Client connect(String room, String origin) throws Exception {
        Client client = new Client();
        WebSocketHttpHeaders headers = new WebSocketHttpHeaders();
        headers.setOrigin(origin);
        // The JSR client defaults to 8 KiB messages, like the server did.
        WebSocketContainer container = ContainerProvider.getWebSocketContainer();
        container.setDefaultMaxBinaryMessageBufferSize(64 * 1024);
        client.session = new StandardWebSocketClient(container)
            .execute(client, headers, URI.create("ws://localhost:" + port + SignalingConfig.PATH + "?room=" + room))
            .get(5, TimeUnit.SECONDS);
        return client;
    }

    @Test
    void fullTwoPlayerFlow() throws Exception {
        Client p1 = connect("flow");
        assertThat(p1.nextIgnoringReadyState()).contains("\"type\":\"welcome\"").contains("\"player\":0");

        Client p2 = connect("flow");
        assertThat(p2.nextIgnoringReadyState()).contains("\"type\":\"welcome\"").contains("\"player\":1");
        assertThat(p1.nextIgnoringReadyState()).contains("\"type\":\"peer-joined\"").contains("\"player\":1");

        // WebRTC signaling is relayed verbatim.
        p1.session.sendMessage(new TextMessage(
            "{\"type\":\"signal\",\"payload\":{\"kind\":\"description\",\"description\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}}"));
        assertThat(p2.nextIgnoringReadyState()).contains("\"type\":\"signal\"").contains("\"sdp\":\"v=0\"");

        // Binary netplay frames are relayed verbatim (fallback transport).
        p2.session.sendMessage(new BinaryMessage(new byte[] {2, 2, 0, 0}));
        ByteBuffer relayed = p1.binaries.poll(5, TimeUnit.SECONDS);
        assertThat(relayed).isNotNull();
        assertThat(relayed.remaining()).isEqualTo(4);

        p1.session.sendMessage(new TextMessage("{\"type\":\"hello\",\"build\":\"abc\"}"));
        p2.session.sendMessage(new TextMessage("{\"type\":\"hello\",\"build\":\"abc\"}"));
        p1.session.sendMessage(new TextMessage("{\"type\":\"ready\",\"ready\":true,\"rttMs\":2.5}"));
        assertThat(p2.next()).contains("\"ready\":[true,false]");
        p2.session.sendMessage(new TextMessage("{\"type\":\"ready\",\"ready\":true,\"rttMs\":3.0}"));
        assertThat(p1.nextIgnoringReadyState()).contains("\"type\":\"match-start\"").contains("\"inputDelay\":2");
        assertThat(p2.nextIgnoringReadyState()).contains("\"type\":\"match-start\"");

        // Player 1 leaves: Player 2 is promoted; the next one to join is Player 2.
        p1.session.close();
        assertThat(p2.nextIgnoringReadyState()).contains("\"type\":\"peer-left\"").contains("\"you\":0");
        Client p3 = connect("flow");
        assertThat(p3.nextIgnoringReadyState()).contains("\"player\":1");

        Client p4 = connect("flow");
        assertThat(p4.next()).contains("\"type\":\"room-full\"");
    }

    @Test
    void roomsAreIndependent() throws Exception {
        Client a = connect("room-a");
        Client b = connect("room-b");
        assertThat(a.nextIgnoringReadyState()).contains("\"player\":0");
        assertThat(b.nextIgnoringReadyState()).contains("\"player\":0");
    }

    @Test
    void lanOriginsAreAcceptedAndPublicOnesRefused() throws Exception {
        Client lan = connect("lan", "https://192.168.0.107:5173");
        assertThat(lan.nextIgnoringReadyState()).contains("\"type\":\"welcome\"");

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> connect("lan", "https://evil.example.com"))
            .hasRootCauseInstanceOf(Exception.class);
    }

    @Test
    void relaysStateSyncSizedBinaryFrames() throws Exception {
        Client p1 = connect("big");
        Client p2 = connect("big");
        p1.nextIgnoringReadyState();
        p2.nextIgnoringReadyState();
        byte[] chunk = new byte[16 * 1024 + 12];
        chunk[0] = 2;
        chunk[chunk.length - 1] = 42;
        p1.session.sendMessage(new BinaryMessage(chunk));
        ByteBuffer relayed = p2.binaries.poll(5, TimeUnit.SECONDS);
        assertThat(relayed).isNotNull();
        assertThat(relayed.remaining()).isEqualTo(chunk.length);
        assertThat(relayed.get(chunk.length - 1)).isEqualTo((byte) 42);
    }
}
