import type { Notification } from "../stores/gameStore";

const VISIBLE = 6;

function time(at: number): string {
  return new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function NotificationFeed({ notifications }: { notifications: Notification[] }) {
  if (notifications.length === 0) {
    return null;
  }
  return (
    <ol className="notifications" aria-live="polite">
      {notifications.slice(0, VISIBLE).map((n) => (
        <li key={n.id} className={`notification ${n.kind}`}>
          <time>{time(n.at)}</time>
          <span>{n.text}</span>
        </li>
      ))}
    </ol>
  );
}
