import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Fullscreen for one element (the game screen with its overlays), tracking
 * changes made outside the app too (Esc, browser UI).
 */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const supported = typeof document !== "undefined" && document.fullscreenEnabled;

  useEffect(() => {
    const update = () => setActive(document.fullscreenElement !== null && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, [target]);

  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await target.current?.requestFullscreen({ navigationUI: "hide" });
      }
    } catch {
      // Refused by the browser (no user gesture, or a permissions policy): stay windowed.
    }
  }, [target]);

  return { active, supported, toggle };
}
