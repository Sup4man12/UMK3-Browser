/// <reference types="vitest/config" />
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localGameData } from "./vite-plugin-local-data.ts";

// Signaling WebSocket served by apps/api (Spring Boot, port 8080). Proxied so the
// page only needs one port, also in LAN mode.
const proxy = { "/ws": { target: "ws://localhost:8080", ws: true } };

export default defineConfig(({ mode }) => {
  // LAN mode (`--mode lan`): listen on every interface and serve HTTPS with a
  // self-signed certificate. Outside localhost, browsers only expose
  // AudioWorklet (and other secure-context APIs) over HTTPS.
  const lan = mode === "lan";

  return {
    plugins: [react(), localGameData(), ...(lan ? [basicSsl({ name: "umk3-online-lan" })] : [])],
    worker: {
      format: "es",
    },
    server: { host: lan, proxy },
    preview: { host: lan, proxy },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            environment: "node",
            include: ["src/**/*.test.ts"],
          },
        },
        {
          extends: true,
          test: {
            name: "core-integration",
            environment: "node",
            include: ["tests/**/*.test.ts"],
            testTimeout: 120_000,
          },
        },
      ],
    },
  };
});
