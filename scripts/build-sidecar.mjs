/**
 * AI Repeat — sidecar build orchestrator (run: npm run agent:sidecar).
 * Stage A: bundle the agent into a single CJS file (esbuild).
 * Stage B: Node SEA — blob + copy node.exe + postject injection.
 * Stage C: place the binary for Tauri externalBin with the target triple.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "build");
const TAURI_BIN = path.join(ROOT, "apps", "desktop", "src-tauri", "binaries");
const TRIPLE = "x86_64-pc-windows-msvc";
const SEA_CONFIG = path.join(OUT_DIR, "sea-config.json");
const BLOB = path.join(OUT_DIR, "sea-prep.blob");
const BUNDLE = path.join(OUT_DIR, "agent-bundle.cjs");
const NODE_EXE = process.execPath;
const AGENT_EXE = path.join(OUT_DIR, "ai-repeat-agent.exe");

/**
 * playwright-core resolves its metadata (package.json / browsers.json) with
 * runtime-computed absolute paths (path.join(packageRoot, …)). Inside a
 * single-file bundle those resolves break — SEA can only load builtins and the
 * embedded script. This plugin rewrites every dynamic `require(join(…, "literal"))`
 * of those two files into a static require, which esbuild then inlines.
 */
function inlinePlaywrightMetadata(playwrightCoreRoot) {
  const base = playwrightCoreRoot.replaceAll("\\", "/");
  return {
    name: "inline-playwright-metadata",
    setup(builder) {
      builder.onLoad({ filter: /playwright-core[\\/].+\.js$/ }, async (args) => {
        const src = readFileSync(args.path, "utf8");
        if (!src.includes("browsers.json") && !src.includes('"package.json")') && !src.includes("'package.json')")) {
          return undefined;
        }
        const patched = src.replace(
          /require\((?:import_\w+|path)\.default\.join\([^,()]+(?:\([^()]*\))?[^,()]*,\s*(["'])((?:package\.json|browsers\.json))\1\)\)/g,
          (_m, _q, filename) => `require(${JSON.stringify(`${base}/${filename}`)})`,
        );
        if (patched === src) return undefined;
        return { contents: patched, loader: "js" };
      });
    },
  };
}

/* ------------------------------- Stage A: bundle --------------------------- */

console.log("[sidecar] A: esbuild bundle…");
await build({
  entryPoints: [path.join(ROOT, "services", "agent", "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: BUNDLE,
  sourcemap: false,
  logLevel: "warning",
  // node:* builtins stay external; everything else (express, zod, playwright-core) inlines.
  packages: "bundle",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [inlinePlaywrightMetadata(path.join(ROOT, "node_modules", "playwright-core"))],
});
console.log(`[sidecar] A: wrote ${path.relative(ROOT, BUNDLE)}`);

/* ------------------------------- Stage B: SEA ------------------------------ */

if (process.platform !== "win32") {
  console.log("[sidecar] B: skipped (SEA injection here is Windows-specific)");
} else {
  console.log("[sidecar] B: Node SEA…");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    SEA_CONFIG,
    JSON.stringify({
      main: path.basename(BUNDLE),
      output: path.basename(BLOB),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    }),
  );
  rmSync(BLOB, { force: true });
  const prep = spawnSync(NODE_EXE, ["--experimental-sea-config", SEA_CONFIG], { cwd: OUT_DIR, encoding: "utf8" });
  if (prep.status !== 0) throw new Error(`sea-config failed: ${prep.stderr}`);
  copyFileSync(NODE_EXE, AGENT_EXE);
  const postject = path.join(ROOT, "node_modules", "postject", "dist", "cli.js");
  if (!existsSync(postject)) throw new Error("postject missing — npm i -D postject");
  const inject = spawnSync(NODE_EXE, [
    postject, AGENT_EXE, "NODE_SEA_BLOB", BLOB,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ], { encoding: "utf8" });
  if (inject.status !== 0) throw new Error(`postject failed: ${inject.stderr || inject.stdout}`);
  console.log(`[sidecar] B: wrote ${path.relative(ROOT, AGENT_EXE)}`);

  /* ---------------------------- Stage C: Tauri bin ------------------------- */

  mkdirSync(TAURI_BIN, { recursive: true });
  const dest = path.join(TAURI_BIN, `ai-repeat-agent-${TRIPLE}.exe`);
  copyFileSync(AGENT_EXE, dest);
  console.log(`[sidecar] C: placed ${path.relative(ROOT, dest)}`);
}
console.log("[sidecar] done");
