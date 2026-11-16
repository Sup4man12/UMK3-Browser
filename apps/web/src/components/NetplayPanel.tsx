import type { RuntimeStats } from "../game/messages";
import type { NetplayState } from "../net/NetplayClient";

const CONNECTION_LABEL: Record<NetplayState["connection"], string> = {
  connecting: "Conectando ao servidor…",
  online: "Conectado",
  offline: "Servidor indisponível",
  "room-full": "Sala cheia",
};

const TRANSPORT_LABEL = {
  connecting: "Negociando WebRTC…",
  p2p: "P2P (WebRTC)",
  relay: "Relay pelo servidor",
} as const;

const player = (slot: 0 | 1) => `Player ${slot + 1}`;

interface NetplayPanelProps {
  netplay: NetplayState | null;
  match: RuntimeStats["match"] | null;
}

export function NetplayPanel({ netplay, match }: NetplayPanelProps) {
  return (
    <section className="panel status">
      <h2>Online</h2>
      {!netplay ? (
        <p className="hint">Disponível quando o jogo terminar de carregar.</p>
      ) : (
        <dl>
          <dt>Sala</dt>
          <dd>{netplay.room}</dd>
          <dt>Servidor</dt>
          <dd>{CONNECTION_LABEL[netplay.connection]}</dd>
          {netplay.player !== null && (
            <>
              <dt>Você é</dt>
              <dd className="you">{player(netplay.player)}</dd>
              <dt>Adversário</dt>
              <dd>{netplay.opponentPresent ? `${player(netplay.player === 0 ? 1 : 0)} na sala` : "Aguardando…"}</dd>
            </>
          )}
          {netplay.transport && (
            <>
              <dt>Conexão</dt>
              <dd>{TRANSPORT_LABEL[netplay.transport]}</dd>
            </>
          )}
          {netplay.rttMs !== null && (
            <>
              <dt>Latência (RTT)</dt>
              <dd>{netplay.rttMs.toFixed(1)} ms</dd>
            </>
          )}
          {netplay.opponentPresent && (
            <>
              <dt>Reiniciar (Enter)</dt>
              <dd>
                P1 {netplay.ready[0] ? "✔" : "—"} · P2 {netplay.ready[1] ? "✔" : "—"}
              </dd>
            </>
          )}
          {netplay.inMatch && (
            <>
              <dt>Input delay</dt>
              <dd>{netplay.inputDelay} frames</dd>
            </>
          )}
          {netplay.inMatch && match && (
            <>
              <dt>Frame da partida</dt>
              <dd>
                {match.frame}
                {match.waiting ? " (aguardando adversário)" : ""}
              </dd>
              <dt>Esperas</dt>
              <dd>{match.stalls}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

/** The one thing the player has to do next, if anything. */
export function nextAction(netplay: NetplayState | null): string | null {
  if (!netplay || netplay.connection !== "online" || netplay.player === null) {
    return null;
  }
  const me = netplay.player;
  const opponent = me === 0 ? 1 : 0;
  if (!netplay.opponentPresent) {
    return `Aguardando ${player(opponent)} entrar na sala…`;
  }
  if (!netplay.transport || netplay.transport === "connecting") {
    return `Conectando a ${player(opponent)}…`;
  }
  if (netplay.syncing) {
    return me === 0 ? "Enviando o jogo para o Player 2…" : "Sincronizando com o jogo do Player 1…";
  }
  if (netplay.ready[opponent] && !netplay.ready[me]) {
    return `${player(opponent)} quer reiniciar do zero: pressione Enter`;
  }
  if (netplay.ready[me] && !netplay.ready[opponent]) {
    return `Aguardando ${player(opponent)} confirmar o reinício (Enter)…`;
  }
  return null;
}
