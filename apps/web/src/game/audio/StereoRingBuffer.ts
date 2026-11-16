/**
 * Stereo sample FIFO between the emulator (pushes one video frame of int16
 * samples at a time) and the AudioWorklet (pulls 128-frame render quanta).
 *
 * The emulator is paced by a wall-clock timer, not by the audio device, so the
 * two clocks drift slightly. The buffer absorbs it: on overflow the oldest
 * samples are dropped, on underrun silence is played until `primeFrames` are
 * buffered again (refilling before resuming avoids rapid crackle).
 */
export class StereoRingBuffer {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readIndex = 0;
  private size = 0;
  private primed = false;

  underruns = 0;
  droppedFrames = 0;

  constructor(
    private readonly capacity: number,
    private readonly primeFrames: number,
  ) {
    if (primeFrames > capacity) {
      throw new RangeError("primeFrames cannot exceed capacity");
    }
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
  }

  get bufferedFrames(): number {
    return this.size;
  }

  /** Appends interleaved int16 stereo samples (L, R, L, R...). */
  push(interleaved: Int16Array): void {
    const frames = interleaved.length >> 1;
    const overflow = this.size + frames - this.capacity;
    if (overflow > 0) {
      this.readIndex = (this.readIndex + overflow) % this.capacity;
      this.size -= overflow;
      this.droppedFrames += overflow;
    }

    let writeIndex = (this.readIndex + this.size) % this.capacity;
    const start = Math.max(0, frames - this.capacity);
    for (let i = start; i < frames; i++) {
      this.left[writeIndex] = interleaved[2 * i]! / 32768;
      this.right[writeIndex] = interleaved[2 * i + 1]! / 32768;
      writeIndex = writeIndex + 1 === this.capacity ? 0 : writeIndex + 1;
    }
    this.size = Math.min(this.capacity, this.size + frames);
  }

  /** Fills both channels completely; missing samples are written as silence. */
  pull(outLeft: Float32Array, outRight: Float32Array): void {
    const wanted = outLeft.length;
    if (!this.primed && this.size >= this.primeFrames) {
      this.primed = true;
    }

    let produced = 0;
    if (this.primed) {
      produced = Math.min(wanted, this.size);
      for (let i = 0; i < produced; i++) {
        outLeft[i] = this.left[this.readIndex]!;
        outRight[i] = this.right[this.readIndex]!;
        this.readIndex = this.readIndex + 1 === this.capacity ? 0 : this.readIndex + 1;
      }
      this.size -= produced;
      if (produced < wanted) {
        this.primed = false;
        this.underruns++;
      }
    }

    outLeft.fill(0, produced);
    outRight.fill(0, produced);
  }

  clear(): void {
    this.readIndex = 0;
    this.size = 0;
    this.primed = false;
  }
}
