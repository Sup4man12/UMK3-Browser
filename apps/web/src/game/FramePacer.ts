/**
 * Fixed-step scheduler: decides how many emulated frames are due at a given
 * wall-clock time for a target refresh rate (54.71 Hz for UMK3, not 60).
 * Pure logic, no timers, so it is deterministic and unit-testable.
 */
export class FramePacer {
  private readonly frameMs: number;
  private nextFrameAt = 0;
  private started = false;

  constructor(
    fps: number,
    /** Upper bound of frames run in one tick; the rest is dropped as lag. */
    private readonly maxCatchUp = 4,
  ) {
    if (!(fps > 0)) {
      throw new RangeError(`invalid fps ${fps}`);
    }
    this.frameMs = 1000 / fps;
  }

  get frameDurationMs(): number {
    return this.frameMs;
  }

  /** Restarts the timeline at `now` (after a pause, for example). */
  restart(now: number): void {
    this.nextFrameAt = now;
    this.started = true;
  }

  /** Returns frames to run now, and how many were dropped to stay real-time. */
  advance(now: number): { run: number; skipped: number } {
    if (!this.started) {
      this.restart(now);
    }
    if (now < this.nextFrameAt) {
      return { run: 0, skipped: 0 };
    }

    const due = Math.floor((now - this.nextFrameAt) / this.frameMs) + 1;
    const run = Math.min(due, this.maxCatchUp);
    const skipped = due - run;
    // Dropped frames move the timeline forward instead of accumulating lag.
    this.nextFrameAt += due * this.frameMs;
    return { run, skipped };
  }

  /** Milliseconds until the next frame is due (0 if already due). */
  msUntilNextFrame(now: number): number {
    return Math.max(0, this.nextFrameAt - now);
  }
}
