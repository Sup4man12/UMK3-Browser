import { useEffect, useRef } from "react";
import { useGameStore } from "../stores/gameStore";
import { GameRuntime } from "./GameRuntime";

interface GameCanvasProps {
  onRuntime(runtime: GameRuntime | null): void;
}

/**
 * Owns the canvas the worker renders into and the GameRuntime bound to it.
 * The <canvas> is created per mount because transferControlToOffscreen() can
 * only be called once per element (React StrictMode mounts effects twice).
 */
export function GameCanvas({ onRuntime }: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "game-canvas";
    container.appendChild(canvas);

    const store = useGameStore.getState();
    const runtime = new GameRuntime(canvas, store.bindings, {
      onEvent: store.applyEvent,
      onAudioEnabled: store.setAudioEnabled,
      onNetplay: store.setNetplay,
      notify: store.notify,
      onCmosSaved: store.setCmosSaved,
    });
    onRuntime(runtime);

    return () => {
      onRuntime(null);
      runtime.dispose();
      canvas.remove();
    };
  }, [onRuntime]);

  return <div ref={containerRef} className="game-screen" />;
}
