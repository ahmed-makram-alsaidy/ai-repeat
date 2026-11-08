# AI Repeat

**Teach it your work once, let it run with you.**

AI Repeat is an Arabic-first, local-first desktop AI coworker that teaches recurring browser tasks and re-runs them in an app-owned browser — without touching the user's real mouse — and verifies every outcome with deterministic checks.

| | |
|---|---|
| 🏠 **Arabic RTL** | Full Arabic RTL interface with English toggle |
| 🔒 **Local-first** | All data stays on your machine; secrets in DPAPI vault |
| 🛡️ **Safe by design** | Deterministic verification, approval gates, network allowlist |
| 📦 **One installer** | Tauri v2 + Node SEA sidecar + Chromium download with consent |
| 🧪 **125 tests** | Unit + integration + real-browser E2E |

> **دليل المستخدم بالعربي:** [USER_GUIDE.md](docs/USER_GUIDE.md) · **خطة الـpilot:** [PILOT_PLAN.md](docs/PILOT_PLAN.md) · **تقرير الشحن:** [SHIPPING_REPORT.md](docs/SHIPPING_REPORT.md)

## What it does

- **Teach → Run → Verify**: record a browser task once, re-run it anytime, and read a real verification report.
- **Isolated browser** (app-owned Chromium via Playwright) — never controls the user's mouse/keyboard.
- **Mandatory approvals** before any external submit, delete, or payment — bound to the exact step fingerprint.
- **Deterministic verification**: url_matches, element_visible, file_exists, table_row_count, text_contains.
- **Scheduled runs** (while the app is open) through the same approval and verification pipeline.
- **GLM-5.3-flash adapter** (Z.ai or any OpenAI-compatible endpoint) + offline demo mode.

## Requirements (Windows 10/11)

- Node.js ≥ 22.14 ([download](https://nodejs.org))
- Rust ≥ 1.75 + MSVC C++ Build Tools ([rustup](https://rustup.rs))
- Chromium for Playwright (one-time, ~150MB): `npx playwright install chromium`

## Quick start

### Desktop app (recommended)

```bash
git clone https://github.com/YOUR_USERNAME/ai-repeat.git
cd ai-repeat
npm install
npm run app          # Tauri dev mode (spawns agent automatically)
npm run app:build    # NSIS installer
```

### Browser-only dev mode

```bash
npm install
npm run build        # Build UI into apps/desktop/dist
npm run agent        # Start agent + fixture site + serve UI
# Open http://127.0.0.1:8757
```

### Tests

```bash
npx vitest run       # Fast suite (73 tests, no browser needed)
npm run test:e2e     # Heavy E2E suite (real Chromium)
npm run smoke        # Offline demo through real executor
```

## Demo flows (no real accounts needed)

| Flow | What it does |
|---|---|
| **G1** — Missing images | Opens fixture products page, filters, exports CSV, verifies row count + file |
| **G2** — Draft transfer | Fills a form, pauses for your approval, then submits |

Both run against a deterministic local fixture server — no third-party accounts.

## Repository layout

```
packages/contracts/    Zod schemas: workflow contract, task model, events
packages/security/     Domain allowlist, path sandbox, redaction, fingerprints
packages/llm/          Provider adapters (OpenAI-compatible, mock, offline)
packages/workflows/    Browser executor, verification engine, recorder, orphan cleanup
services/agent/        Loopback HTTP API, task queue, SQLite, DPAPI vault, scheduler
apps/desktop/          Tauri v2 shell + Arabic RTL React UI (Vite)
fixtures/demo-site/    Deterministic local fixture web server
fixtures/workflows/    Seeded demo workflows
docs/                  Shipping report, status, user guide, pilot plan
tests/                 Fast unit tests (no Chromium needed)
tests/e2e/             Heavy E2E tests (real browser, real processes)
scripts/               Build scripts (sidecar bundler, smoke demo)
```

## Safety model

1. **Code enforces policy** — never the model, never the JSON. Tools are a closed, typed allowlist.
2. **Network-level domain guard**: any request outside `allowedDomains` is aborted in-browser.
3. **Secrets**: never stored, never logged, never typed into password fields; API key lives in Windows DPAPI vault only.
4. **Approvals**: external_write/high_impact pause the task; consent binds to an exact action fingerprint and expires.
5. **No CAPTCHA/MFA bypass, no stealth monitoring, no telemetry.**

## License

[MIT](LICENSE)
