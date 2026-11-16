import { describe, expect, it } from "vitest";
import { FramePacer } from "./FramePacer";

describe("FramePacer", () => {
  const fps = 54.71;
  const frameMs = 1000 / fps;

  it("runs one frame immediately and then one per frame period", () => {
    const pacer = new FramePacer(fps);
    expect(pacer.advance(1000)).toEqual({ run: 1, skipped: 0 });
    expect(pacer.advance(1000 + frameMs / 2)).toEqual({ run: 0, skipped: 0 });
    expect(pacer.advance(1000 + frameMs)).toEqual({ run: 1, skipped: 0 });
  });

  it("averages exactly the target rate over a long run", () => {
    const pacer = new FramePacer(fps);
    let frames = 0;
    for (let t = 0; t < 10_000; t += 4) {
      frames += pacer.advance(t).run;
    }
    // 10 s at 54.71 Hz -> 547 or 548 frames, never 600 (60 Hz).
    expect(frames).toBeGreaterThanOrEqual(547);
    expect(frames).toBeLessThanOrEqual(548);
  });

  it("catches up a bounded number of frames and reports the rest as skipped", () => {
    const pacer = new FramePacer(fps, 4);
    pacer.advance(0);
    const result = pacer.advance(10 * frameMs + 1);
    expect(result).toEqual({ run: 4, skipped: 6 });
    expect(pacer.advance(10 * frameMs + 2)).toEqual({ run: 0, skipped: 0 });
  });

  it("does not run a burst after restart", () => {
    const pacer = new FramePacer(fps);
    pacer.advance(0);
    pacer.restart(60_000);
    expect(pacer.advance(60_000)).toEqual({ run: 1, skipped: 0 });
  });

  it("reports the wait until the next frame", () => {
    const pacer = new FramePacer(fps);
    pacer.advance(0);
    expect(pacer.msUntilNextFrame(5)).toBeCloseTo(frameMs - 5);
  });
});
