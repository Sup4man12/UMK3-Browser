import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Connect, Plugin } from "vite";

const DATA_DIR = resolve(import.meta.dirname, "../../data");

interface Route {
  /** URL prefix, mirrored by ROMS_URL / NVRAM_URL in GameRuntime.ts. */
  prefix: string;
  dir: string;
  extensions: RegExp;
}

/**
 * Serves the developer's own game data on the dev and preview servers:
 *
 *   GET /roms/          -> JSON array of ROM file names in data/roms (UMK3_ROM_DIR)
 *   GET /roms/<file>    -> file contents
 *   GET /nvram/<file>   -> NVRAM dump from data/nvram (UMK3_NVRAM_DIR), e.g. umk3p.fs
 *
 * Only the Vite servers use this middleware. Nothing is copied into the
 * production build: publishing ROMs would mean distributing them.
 */
export function localGameData(): Plugin {
  const routes: Route[] = [
    {
      prefix: "/roms/",
      dir: resolve(process.env.UMK3_ROM_DIR ?? join(DATA_DIR, "roms")),
      extensions: /\.(zip|ips|bin|u\d+)$/i,
    },
    {
      prefix: "/nvram/",
      dir: resolve(process.env.UMK3_NVRAM_DIR ?? join(DATA_DIR, "nvram")),
      extensions: /\.fs$/i,
    },
  ];

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "";
    const route = routes.find((r) => url.startsWith(r.prefix));
    if (!route || req.method !== "GET") {
      return next();
    }

    const name = decodeURIComponent(url.slice(route.prefix.length).split("?")[0] ?? "");
    if (name === "") {
      const files = existsSync(route.dir)
        ? readdirSync(route.dir).filter((f) => route.extensions.test(f) && statSync(join(route.dir, f)).isFile())
        : [];
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(files.sort()));
      return;
    }

    // Plain file names only: no sub-directories, no "..".
    const path = join(route.dir, name);
    if (basename(name) !== name || !route.extensions.test(name) || !existsSync(path)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", statSync(path).size);
    res.setHeader("Cache-Control", "no-store");
    createReadStream(path).pipe(res);
  };

  return {
    name: "umk3-local-game-data",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
