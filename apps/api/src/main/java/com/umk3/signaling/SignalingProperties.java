package com.umk3.signaling;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @param allowedOriginPatterns browser origins allowed to open the signaling
 *     WebSocket, as Spring origin patterns (e.g. {@code https://192.168.*.*:*})
 */
@ConfigurationProperties(prefix = "umk3.signaling")
public record SignalingProperties(List<String> allowedOriginPatterns) {

    public SignalingProperties {
        allowedOriginPatterns = allowedOriginPatterns == null ? List.of() : List.copyOf(allowedOriginPatterns);
    }
}
