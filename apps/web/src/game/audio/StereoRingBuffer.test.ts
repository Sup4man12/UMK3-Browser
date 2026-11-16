import { describe, expect, it } from "vitest";
import { StereoRingBuffer } from "./StereoRingBuffer";

const stereo = (...pairs: [number, number][]) => new Int16Array(pairs.flat());

function pull(buffer: StereoRingBuffer, frames: number) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  buffer.pull(l, r);
  return { l: [...l], r: [...r] };
}

describe("StereoRingBuffer", () => {
  it("plays silence until primed, then returns samples in order", () => {
    const buffer = new StereoRingBuffer(8, 2);
    buffer.push(stereo([16384, -16384]));
    expect(pull(buffer, 1)).toEqual({ l: [0], r: [0] });

    buffer.push(stereo([8192, 0]));
    expect(pull(buffer, 2)).toEqual({ l: [0.5, 0.25], r: [-0.5, 0] });
    expect(buffer.bufferedFrames).toBe(0);
  });

  it("counts an underrun and re-primes before resuming", () => {
    const buffer = new StereoRingBuffer(8, 2);
    buffer.push(stereo([1, 1], [2, 2]));
    pull(buffer, 3);
    expect(buffer.underruns).toBe(1);

    buffer.push(stereo([3276, 3276]));
    expect(pull(buffer, 1).l).toEqual([0]);
  });

  it("drops the oldest frames on overflow and wraps around", () => {
    const buffer = new StereoRingBuffer(4, 1);
    buffer.push(stereo([1, 1], [2, 2], [3, 3]));
    buffer.push(stereo([4, 4], [5, 5], [6, 6]));
    expect(buffer.droppedFrames).toBe(2);
    expect(pull(buffer, 4).l.map((v) => Math.round(v * 32768))).toEqual([3, 4, 5, 6]);
  });

  it("clear() empties and un-primes", () => {
    const buffer = new StereoRingBuffer(4, 1);
    buffer.push(stereo([1, 1]));
    buffer.clear();
    expect(buffer.bufferedFrames).toBe(0);
    expect(pull(buffer, 1).l).toEqual([0]);
  });
});
