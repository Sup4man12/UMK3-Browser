import { useCallback, useEffect, useRef } from "react";
import { ControlsPanel } from "../components/ControlsPanel";
import { FullscreenToast } from "../components/FullscreenToast";
import { MissingRoms } from "../components/MissingRoms";
import { NetplayPanel, nextAction } from "../components/NetplayPanel";
import { NotificationFeed } from "../components/NotificationFeed";
import { StatusPanel } from "../components/StatusPanel";
import { GameCanvas } from "../game/GameCanvas";
import type { GameRuntime } from "../game/GameRuntime";
import type { KeyBindings } from "../game/InputManager";
import { useFullscreen } from "../hooks/useFullscreen";
import { useGameStore } from "../stores/gameStore";

export function PlayPage() {
  const runtimeRef = useRef<GameRuntime | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(screenRef);
  const state = useGameStore();

  const onRuntime = useCallback((runtime: GameRuntime | null) => {
    runtimeRef.current = runtime;
  }, []);

  const onBindings = useCallback(
    (bindings: KeyBindings) => {
      state.setBindings(bindings);
      runtimeRef.current?.setBindings(bindings);
    },
    [state.setBindings],
  );

  const loaded = state.phase === "paused" || state.phase === "running";
  const inMatch = state.netplay?.inMatch ?? false;
  // Pausing, stepping or loading a state on one side only would desync the match.
  const offlineOnly = loaded && !inMatch;
  const action = nextAction(state.netplay);

  // Start as soon as the ROMs from data/roms are verified and loaded.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (state.phase === "paused" && !autoStarted.current) {
      autoStarted.current = true;
      runtimeRef.current?.start();
    }
  }, [state.phase]);

  return (
    <main className="layout">
      <header>
        <h1>UMK3 Plus Online</h1>
        <p className="hint">Prova de conceito: FBNeo (driver <code>umk3p</code>) em WebAssembly.</p>
        {loaded && !state.audioEnabled && (
          <p className="hint">Som desligado: clique na página ou pressione uma tecla para ativá-lo.</p>
        )}
      </header>

      <div className="stage">
        <div
          ref={screenRef}
          className="screen-wrapper"
          onDoubleClick={() => void fullscreen.toggle()}
          title="Duplo clique: tela cheia"
        >
          <GameCanvas onRuntime={onRuntime} />
          {state.netplay?.player !== null && state.netplay?.player !== undefined && (
            <div className="player-badge">Você: Player {state.netplay.player + 1}</div>
          )}
          {action && <div className="call-to-action">{action}</div>}
          {fullscreen.active && <FullscreenToast notification={state.notifications[0]} />}
          {fullscreen.supported && (
            <button
              type="button"
              className="fullscreen-toggle"
              onClick={() => void fullscreen.toggle()}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={fullscreen.active ? "Sair da tela cheia" : "Tela cheia"}
              title={fullscreen.active ? "Sair da tela cheia (Esc)" : "Tela cheia (ou duplo clique na tela)"}
            >
              {fullscreen.active ? "⤡" : "⛶"}
            </button>
          )}
        </div>
        <div className="toolbar">
          <button type="button" disabled={!fullscreen.supported} onClick={() => void fullscreen.toggle()}>
            {fullscreen.active ? "Sair da tela cheia" : "Tela cheia"}
          </button>
          {state.phase === "running" ? (
            <button type="button" disabled={!offlineOnly} onClick={() => runtimeRef.current?.pause()}>
              Pausar
            </button>
          ) : (
            <button type="button" disabled={!loaded} onClick={() => runtimeRef.current?.start()}>
              Continuar
            </button>
          )}
          <button type="button" disabled={!offlineOnly || state.phase !== "paused"} onClick={() => runtimeRef.current?.step()}>
            Avançar 1 frame
          </button>
          <button type="button" disabled={!offlineOnly} onClick={() => runtimeRef.current?.reset()}>
            Reset
          </button>
          <button type="button" disabled={!offlineOnly} onClick={() => runtimeRef.current?.saveState()}>
            Salvar estado
          </button>
          <button
            type="button"
            disabled={!offlineOnly || state.savedStateBytes === null}
            onClick={() => runtimeRef.current?.loadState()}
          >
            Carregar estado
          </button>
          <button
            type="button"
            disabled={!offlineOnly}
            onClick={() => runtimeRef.current?.openTestMenu()}
            title="Menu de teste da placa (UMK3+ settings). Também com F2. Só offline."
          >
            Menu de teste (F2)
          </button>
          {inMatch && <span className="hint">Partida online. Enter nos dois reinicia do zero.</span>}
        </div>
        <NotificationFeed notifications={state.notifications} />
      </div>

      <aside className="sidebar">
        <NetplayPanel netplay={state.netplay} match={state.stats?.match ?? null} />
        <StatusPanel
          phase={state.phase}
          driverName={state.driverName}
          video={state.video}
          cmos={state.cmos}
          cmosSavedAt={state.cmosSavedAt}
          stats={state.stats}
          onForgetCmos={() => {
            if (window.confirm("Apagar as configurações da máquina salvas neste navegador e recarregar?")) {
              runtimeRef.current?.forgetSavedCmos();
              window.location.reload();
            }
          }}
        />
        {state.phase === "roms-missing" && state.romReport && <MissingRoms report={state.romReport} />}
        <ControlsPanel bindings={state.bindings} onChange={onBindings} />
      </aside>
    </main>
  );
}
