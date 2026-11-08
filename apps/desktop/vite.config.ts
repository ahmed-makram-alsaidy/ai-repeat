/// <reference types="vitest" />
import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const AGENT_PORT = process.env.AI_REPEAT_AGENT_PORT ?? "8757";
const TOKEN_FILE = path.resolve(__dirname, ".session-token");

/**
 * Dev-only bridge: reads the agent's per-session token from disk (never from
 * the network) and injects it as the Authorization header for /api proxies,
 * re-reading whenever the agent restarts. In the packaged desktop shell the
 * token arrives via secure IPC instead.
 */
function readToken(): string | null {
  try {
    const s = statSync(TOKEN_FILE);
    void s;
    return readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function agentAuthBridge(server: ViteDevServer) {
  server.middlewares.use("/dev-session", (_req, res) => {
    const token = readToken();
    res.setHeader("Content-Type", "application/json");
    if (!token) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "AGENT_TOKEN_UNAVAILABLE: شغّل الـagent الأول (npm run agent)" }));
      return;
    }
    res.end(JSON.stringify({ token }));
  });
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "agent-auth-bridge",
      configureServer(server) {
        agentAuthBridge(server);
        // SSE must not be buffered by the http proxy.
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith("/api/events")) {
            const token = readToken();
            if (token) req.headers.authorization = `Bearer ${token}`;
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${AGENT_PORT}`,
        changeOrigin: false,
        // Fresh token on every proxied request (the agent rotates it per session).
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            const token = readToken();
            if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
  },
});

