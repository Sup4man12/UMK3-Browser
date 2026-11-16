package com.umk3.signaling;

/**
 * Input delay (in emulated frames) for a match. Each player's input must reach
 * the other peer before that frame runs, so the delay has to cover one-way
 * latency plus a frame of margin for jitter and main-thread scheduling.
 */
final class InputDelayPolicy {

    /** UMK3 runs at 54.71 Hz (Midway Wolf-unit), not 60 Hz. */
    static final double FRAME_MS = 1000.0 / 54.71;
    static final int MIN_DELAY = 2;
    static final int MAX_DELAY = 8;
    /** Used while no round trip has been measured yet. */
    static final int DEFAULT_DELAY = 3;

    private InputDelayPolicy() {
    }

    /** @param rttMs worst measured round trip of both players, or null when unknown */
    static int forRoundTrip(Double rttMs) {
        if (rttMs == null || rttMs.isNaN() || rttMs < 0) {
            return DEFAULT_DELAY;
        }
        int frames = (int) Math.ceil((rttMs / 2.0) / FRAME_MS) + 1;
        return Math.clamp(frames, MIN_DELAY, MAX_DELAY);
    }
}
