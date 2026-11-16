// AudioWorklet processor. Receives samples straight from the GameWorker through
// a MessagePort, so audio never passes through the React thread.

import { AUDIO_PROCESSOR_NAME, type AudioMessage } from "./audio-protocol";
import { StereoRingBuffer } from "./StereoRingBuffer";

class EmulatorAudioProcessor extends AudioWorkletProcessor {
  // ~170 ms of capacity; play starts once ~3 video frames (~55 ms) are queued.
  private readonly buffer = new StereoRingBuffer(Math.round(sampleRate * 0.17), Math.round(sampleRate * 0.055));

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ port: MessagePort }>) => {
      event.data.port.onmessage = (e: MessageEvent<AudioMessage>) => {
        if (e.data.type === "SAMPLES") {
          this.buffer.push(e.data.samples);
        } else {
          this.buffer.clear();
        }
      };
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (output && output.length >= 2) {
      this.buffer.pull(output[0]!, output[1]!);
    }
    return true;
  }
}

registerProcessor(AUDIO_PROCESSOR_NAME, EmulatorAudioProcessor);
