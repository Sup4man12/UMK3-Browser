import type { CmosSource, RuntimeStats } from "../game/messages";
import type { GamePhase } from "../stores/gameStore";

const PHASE_LABEL: Record<GamePhase, string> = {
  "loading-core": "Carregando emulador…",
  "loading-roms": "Carregando ROMs de data/roms…",
  "roms-missing": "ROM set incompleto",
  paused: "Pausado",
  running: "Rodando",
  fatal: "Falha ao carregar",
};

interface StatusPanelProps {
  phase: GamePhase;
  driverName: string | null;
  video: { width: number; height: number; fps: number } | null;
  cmos: CmosSource | null;
  cmosSavedAt: number | null;
  stats: RuntimeStats | null;
  onForgetCmos(): void;
}

const CMOS_LABEL: Record<CmosSource, string> = {
  browser: "suas configurações (salvas neste navegador)",
  file: "data/nvram/umk3p.fs",
  factory: "padrão de fábrica",
};

export function StatusPanel({ phase, driverName, video, cmos, cmosSavedAt, stats, onForgetCmos }: StatusPanelProps) {
  return (
    <section className="panel status">
      <dl>
        <dt>Estado</dt>
        <dd>{PHASE_LABEL[phase]}</dd>
        {driverName && (
          <>
            <dt>Driver</dt>
            <dd>{driverName}</dd>
          </>
        )}
        {video && (
          <>
            <dt>Vídeo</dt>
            <dd>
              {video.width}×{video.height} @ {video.fps.toFixed(2)} Hz
            </dd>
            <dt>CMOS</dt>
            <dd>
              {cmos ? CMOS_LABEL[cmos] : "—"}
              {cmosSavedAt !== null && (
                <span className="hint">
                  {" "}
                  · salva às {new Date(cmosSavedAt).toLocaleTimeString("pt-BR")}
                </span>
              )}
              {(cmos === "browser" || cmosSavedAt !== null) && (
                <button type="button" className="link-button" onClick={onForgetCmos}>
                  Apagar minhas configurações
                </button>
              )}
            </dd>
          </>
        )}
        {stats && phase === "running" && (
          <>
            <dt>FPS</dt>
            <dd>{stats.fps.toFixed(2)}</dd>
            <dt>Custo/frame</dt>
            <dd>{stats.emulationMsPerFrame.toFixed(2)} ms</dd>
            <dt>Frames pulados</dt>
            <dd>{stats.skippedFrames}</dd>
            <dt>Frame</dt>
            <dd>{stats.frame}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
