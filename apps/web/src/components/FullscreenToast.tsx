import { useEffect, useState } from "react";
import type { Notification } from "../stores/gameStore";

const VISIBLE_MS = 6000;

/**
 * In fullscreen the notification feed is off screen, so the newest
 * notification is shown over the game for a few seconds.
 */
export function FullscreenToast({ notification }: { notification: Notification | undefined }) {
  const [visible, setVisible] = useState<Notification | null>(null);

  useEffect(() => {
    if (!notification || Date.now() - notification.at > VISIBLE_MS) {
      return;
    }
    setVisible(notification);
    const timer = setTimeout(() => setVisible(null), VISIBLE_MS - (Date.now() - notification.at));
    return () => clearTimeout(timer);
  }, [notification]);

  if (!visible) {
    return null;
  }
  return <div className={`fullscreen-toast ${visible.kind}`}>{visible.text}</div>;
}
