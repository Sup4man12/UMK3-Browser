import { formatCrc } from "../game/rom/crc32";
import type { SlotReport } from "../game/rom/romset";

/** Shown when data/roms does not contain a complete, verified ROM set. */
export function MissingRoms({ report }: { report: SlotReport[] }) {
  const missing = report.filter((r) => r.status.kind === "missing" && !r.slot.optional);
  return (
    <section className="panel">
      <h2>ROMs</h2>
      <p className="error-text">
        Faltam {missing.length} de {report.filter((r) => !r.slot.optional).length} ROMs obrigatórias em{" "}
        <code>data/roms/</code>. Coloque lá <code>umk3.zip</code> + <code>umk3p.zip</code> (ou o zip do patch do UMK3
        Plus) e recarregue a página.
      </p>
      <ul className="rom-report">
        {missing.map(({ slot }) => (
          <li key={slot.index}>
            <code>{slot.name}</code> crc {formatCrc(slot.crc)} ({slot.length / 1024} KiB)
          </li>
        ))}
      </ul>
    </section>
  );
}
