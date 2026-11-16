// Contract between the GameWorker and the AudioWorklet. Kept free of DOM and
// worker types because it is compiled into the AudioWorkletGlobalScope too.

export const AUDIO_PROCESSOR_NAME = "umk3-audio";

/** GameWorker -> AudioWorklet (over the transferred MessagePort). */
export type AudioMessage =
  | { type: "SAMPLES"; samples: Int16Array }
  | { type: "CLEAR" };
