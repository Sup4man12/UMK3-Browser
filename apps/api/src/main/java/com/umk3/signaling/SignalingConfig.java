package com.umk3.signaling;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
class SignalingConfig implements WebSocketConfigurer {

    static final String PATH = "/ws/signaling";

    private final SignalingHandler handler;
    private final SignalingProperties properties;

    SignalingConfig(SignalingHandler handler, SignalingProperties properties) {
        this.handler = handler;
        this.properties = properties;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, PATH)
            .setAllowedOriginPatterns(properties.allowedOriginPatterns().toArray(String[]::new));
    }
}
