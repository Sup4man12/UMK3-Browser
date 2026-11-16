import type { ButtonName } from "@umk3/protocol";
import { useEffect, useState } from "react";
import { DEFAULT_BINDINGS, RESERVED_KEYS, rebind, type KeyBindings } from "../game/InputManager";

const ACTIONS: { name: ButtonName; label: string }[] = [
  { name: "Up", label: "Cima" },
  { name: "Down", label: "Baixo" },
  { name: "Left", label: "Esquerda" },
  { name: "Right", label: "Direita" },
  { name: "Fire1", label: "Soco alto" },
  { name: "Fire2", label: "Bloqueio" },
  { name: "Fire3", label: "Chute alto" },
  { name: "Fire4", label: "Soco baixo" },
  { name: "Fire6", label: "Correr" },
  { name: "Fire5", label: "Chute baixo" },
  { name: "Start", label: "Start" },
  { name: "Coin", label: "Ficha" },
];

interface ControlsPanelProps {
  bindings: KeyBindings;
  onChange(bindings: KeyBindings): void;
}

export function ControlsPanel({ bindings, onChange }: ControlsPanelProps) {
  const [listening, setListening] = useState<ButtonName | null>(null);

  useEffect(() => {
    if (!listening) {
      return;
    }
    // Capture phase so the game's InputManager (and Enter's ready toggle) do not see this key.
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!RESERVED_KEYS.has(event.code)) {
        onChange(rebind(bindings, listening, event.code));
      }
      setListening(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening, bindings, onChange]);

  return (
    <section className="panel">
      <h2>Controles</h2>
      <p className="hint">
        Valem para você, seja Player 1 ou Player 2: os dois jogadores usam o mesmo mapeamento no próprio teclado.
        <kbd>Enter</kbd> é reservado: nos dois jogadores, reinicia a partida online do zero.
      </p>
      <table className="controls">
        <tbody>
          {ACTIONS.map(({ name, label }) => (
            <tr key={name}>
              <td>{label}</td>
              <td>
                <button type="button" className="key" onClick={() => setListening(name)}>
                  {listening === name ? "pressione…" : (bindings[name] ?? "—")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => onChange(DEFAULT_BINDINGS)}>
        Restaurar padrão
      </button>
    </section>
  );
}
