# Contributing to AI Repeat

## Development setup

```bash
# Prerequisites: Node.js ≥ 22.14, Rust ≥ 1.75, VS C++ Build Tools
git clone https://github.com/YOUR_USERNAME/ai-repeat.git
cd ai-repeat
npm install
npx playwright install chromium   # one-time browser download

# Development
npm run app                        # Tauri dev (spawns agent + UI)
npm run ui                         # Browser-only dev mode

# Testing
npx vitest run                     # Fast suite (73 tests, no browser)
npx vitest run --config vitest.e2e.config.ts   # Heavy E2E suite (real Chromium)
npm run smoke                      # Offline demo

# Building
npm run app:build                  # NSIS installer
npm run agent:sidecar              # Standalone agent binary
```

## Architecture

```
packages/contracts/   → Zod schemas (workflow, tasks, events)
packages/security/    → Domain allowlist, path sandbox, redaction, fingerprints
packages/llm/         → Provider adapters (OpenAI-compatible, mock, offline)
packages/workflows/   → Browser executor, verification engine, recorder
services/agent/       → Loopback API, task queue, SQLite, DPAPI vault, scheduler
apps/desktop/         → Tauri v2 shell + Arabic RTL React UI
fixtures/demo-site/   → Deterministic fixture web server
tests/                → Fast unit tests (no Chromium)
tests/e2e/            → Heavy E2E tests (real browser, real processes)
```

## Key principles

1. **Code enforces policy** — never the model, never the JSON
2. **Network-level domain guard** — unapproved domains are aborted in-browser
3. **Secrets**: never stored, never logged, never sent to the model
4. **Every verification is deterministic** — independent of any LLM claim
5. **No CAPTCHA/MFA bypass** — manual handoff always

## Adding a new browser tool

1. Add the action name to `STEP_ACTIONS` in `packages/contracts/src/index.ts`
2. Implement the handler in `executeStep()` in `packages/workflows/src/executor.ts`
3. Add security checks (allowlist, sandbox, redaction) in the handler
4. Add E2E tests in `tests/e2e/`
5. Update the verification engine if the tool produces verifiable outcomes

## Pull requests

- All 73+ fast tests must pass (`npx vitest run`)
- E2E tests should pass (`npm run test:e2e`)
- No hardcoded credentials, paths, or personal data
- Security-sensitive changes require explicit review
