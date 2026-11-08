<div align="center">

# AI Repeat

**Teach it your work once, let it run with you.**

An Arabic-first, local-first desktop AI coworker that teaches recurring browser tasks and re-runs them in an app-owned browser — without touching the user's real mouse — and verifies every outcome with deterministic checks.

[![CI](https://github.com/ahmed-makram-alsaidy/ai-repeat/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmed-makram-alsaidy/ai-repeat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-73%20pass-brightgreen)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522.14-green)]()
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)]()

**[English](#features) · [العربي](#arabic) · [Screenshots](#-screenshots) · [Architecture](#-architecture) · [Quick Start](#-quick-start) · [Safety](#-safety-model) · [Contributing](CONTRIBUTING.md)**

</div>

---

## ✨ Features

| | |
|---|---|
| 🎓 **Teach** | Record a browser task once (or describe it in Arabic and let AI draft it) |
| ▶️ **Run** | Re-execute in an app-owned Chromium browser — never touches your mouse |
| ✅ **Verify** | 5 deterministic assertion types — independent of any LLM claim |
| 🛡️ **Approve** | External actions pause and wait for your explicit fingerprint-bound consent |
| ⏰ **Schedule** | Interval or daily recurring — through the same approval pipeline |
| 🔊 **Voice** | Push-to-talk (Web Speech) + local whisper STT + TTS summaries |
| 🌍 **i18n** | Arabic RTL + English LTR toggle |
| 💾 **Backup** | Full workspace export/import (skills + tasks + schedules) |
| 🔍 **UIA** | Read-only Windows UIA inspection + InvokePattern (experimental) |

---

## 📸 Screenshots

<div align="center">

### Home Dashboard

![Home Dashboard](docs/screenshots/screenshot-home-dashboard.png)

### Task Completed — Full Verification Report

![Task Completed](docs/screenshots/screenshot-task-completed-verification.png)

### Task Detail — Steps Timeline

![Task Detail](docs/screenshots/screenshot-task-detail-steps.png)

### Skills — Schedule + Version History

![Skills](docs/screenshots/screenshot-skills-schedule-versions.png)

### CSV Output Preview

![CSV Preview](docs/screenshots/screenshot-task-csv-preview.png)

### Settings — STT Engine Configuration

![Settings STT](docs/screenshots/screenshot-settings-stt-voice.png)

### Execution Log — Audit Trail

![Logs](docs/screenshots/screenshot-logs-audit-trail.png)

### Assistant — Offline Fallback

![Assistant](docs/screenshots/screenshot-assistant-offline-fallback.png)

### Tasks List

![Tasks List](docs/screenshots/screenshot-tasks-list.png)

### Skills Cards

![Skills Cards](docs/screenshots/screenshot-skills-cards.png)

### Skills Expanded Details

![Skills Expanded](docs/screenshots/screenshot-skills-expanded-details.png)

### Settings — Security & Backup

![Settings Security](docs/screenshots/screenshot-settings-security-backup.png)

</div>

---

## 🏗 Architecture

<div align="center">

```mermaid
graph TB
    subgraph Desktop["Desktop Shell (Tauri v2)"]
        UI["Arabic RTL React UI"]
        IPC["Secure IPC → session token"]
        WEBVIEW["WebView2 Window"]
    end

    subgraph Agent["Agent Service (Node SEA Sidecar)"]
        API["Loopback HTTP API :8757"]
        QUEUE["Task Queue + State Machine"]
        SCHED["Scheduler (20s tick)"]
        VAULT["DPAPI Vault"]
        STORE["SQLite (WAL)"]
    end

    subgraph Browser["Browser Layer (Playwright)"]
        GUARD["Network Domain Guard"]
        EXEC["Tool Executor (typed allowlist)"]
        VERIFY["Verification Engine (5 types)"]
    end

    subgraph External["External Services"]
        MODEL["GLM-5.3-flash (Z.ai)"]
        FIXTURE["Demo Site :4177"]
        TARGET["Target Websites"]
    end

    WEBVIEW --> UI
    UI -->|"Bearer token"| API
    IPC --> API
    API --> QUEUE
    QUEUE --> EXEC
    SCHED --> QUEUE
    EXEC --> GUARD
    GUARD --> FIXTURE
    GUARD --> TARGET
    EXEC --> VERIFY
    EXEC --> MODEL
    VAULT --> API
    STORE <--> QUEUE
```

</div>

### Task Lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued: createTask()
    queued --> running: launch browser
    running --> awaiting_approval: external_write step
    awaiting_approval --> running: approved (fingerprint match)
    awaiting_approval --> failed: rejected / expired
    running --> paused: user pauses
    running --> completed: all verifications pass
    running --> failed: step error
    running --> cancelled: user cancels
    paused --> running: resume (checkpoint skip)
```

### Security Layers

```mermaid
flowchart TB
    L1["Layer 1: Input Validation<br/>Zod Schema · Path Sandbox · Fingerprint"]
    L2["Layer 2: Execution Guards<br/>Network Guard · Secret Guard · Approval Gate · Budget"]
    L3["Layer 3: Output Redaction<br/>DB Writes · Event Log · Backup"]

    L1 --> L2 --> L3
```

> More diagrams: [docs/diagrams/ARCHITECTURE.md](docs/diagrams/ARCHITECTURE.md)

---

## 🚀 Quick Start

### Desktop App (Recommended)

```bash
git clone https://github.com/ahmed-makram-alsaidy/ai-repeat.git
cd ai-repeat
npm install
npx playwright install chromium
npm run app          # Tauri dev mode (spawns agent automatically)
npm run app:build    # NSIS installer
```

### Browser-only Dev Mode

```bash
npm install
npm run build
npm run agent        # Agent + fixture site + UI at http://127.0.0.1:8757
```

### Tests

```bash
npx vitest run       # Fast suite (73 tests, no browser)
npm run test:e2e     # Heavy E2E suite (real Chromium)
npm run smoke        # Offline demo through real executor
```

### Build from source

| Command | Output |
|---|---|
| `npm run app:build` | NSIS installer |
| `npm run agent:sidecar` | Standalone agent binary (Node SEA) |
| `npm run smoke` | Offline G1 demo |

---

## 📦 Download

Download the latest signed installer from [Releases](https://github.com/ahmed-makram-alsaidy/ai-repeat/releases):

- **AI.Repeat_0.1.0_x64-setup.exe** (25MB) — includes Tauri shell + agent sidecar
- On first launch, the app will ask consent to download Chromium (~150MB)

---

## 🎯 Demo flows (no real accounts needed)

| Flow | What it does |
|---|---|
| **G1** — Missing images | Opens fixture products page, filters, exports CSV, verifies row count + file |
| **G2** — Draft transfer | Fills a form, pauses for your approval, then submits |

Both run against a deterministic local fixture server at `127.0.0.1:4177`.

---

## 📂 Repository Layout

```
packages/contracts/    Zod schemas: workflow, tasks, events, schedules
packages/security/     Domain allowlist, path sandbox, redaction, fingerprints
packages/llm/          Provider adapters (OpenAI-compatible, mock, offline)
packages/workflows/    Browser executor, verification, recorder, orphan cleanup
services/agent/        Loopback API, task queue, SQLite, DPAPI vault, scheduler
apps/desktop/          Tauri v2 shell + Arabic RTL React UI (Vite)
fixtures/demo-site/    Deterministic fixture web server
fixtures/workflows/    Seeded demo workflows
docs/                  Shipping report, user guide, pilot plan, diagrams
tests/                 Fast unit tests (no Chromium)
tests/e2e/             Heavy E2E tests (real browser)
scripts/               Build scripts (sidecar bundler, smoke demo)
.github/workflows/     GitHub Actions CI
```

---

## 🛡 Safety Model

1. **Code enforces policy** — never the model, never the JSON. Tools are a closed, typed allowlist.
2. **Network-level domain guard**: any request outside `allowedDomains` is aborted in-browser.
3. **Secrets**: never stored, never logged, never typed into password fields; API key lives in Windows DPAPI vault only.
4. **Approvals**: external_write/high_impact pause the task; consent binds to an exact action fingerprint and expires.
5. **No CAPTCHA/MFA bypass, no stealth monitoring, no telemetry.**

---

<div align="center" id="arabic">

## العربي

**علّمه شغلك مرة، وخليه يشتغل معاك.**

AI Repeat هو مساعد ذكي مكتبي عربي محلي بيتعلم مهام متصفح متكررة من المستخدم ويعيد تنفيذها في متصفح مستقل — من غير ما يحرك ماوس المستخدم الحقيقي — ويتحقق من النتيجة بفحوصات حتمية.

### ليه AI Repeat؟

- **متصفح مستقل** — أتمتة المتصفح فقط، بدون أي تحكم في ماوس/كيبورد ويندوز
- **موافقات إلزامية** — أي إرسال خارجي أو حذف أو دفع بيقف ويطلب موافقتك ببصمة مشفرة
- **تحقق حتمي** — 5 أنواع تحقق مستقلة عن أي ادعاء من النموذج الذكي
- **مجاني ومفتوح المصدر** — MIT License
- **خصوصية كاملة** — كل بياناتك على جهازك، المفتاح في مخزن ويندوز المشفر

### ابدأ في 3 خطوات

1. **نزّل المتصفح** — الإعدادات → متصفح التطبيق → نزّل (~150MB مرة واحدة)
2. **شغّل الـdemo** — مهاراتي → شغّل أي مهارة → شاهد التقرير
3. **علّم مهمة حقيقية** — علّمني مهمة → ابدأ التسجيل → نفّذ → احفظ

**[دليل المستخدم الكامل بالعربي](docs/USER_GUIDE.md)**

</div>

---

## License

[MIT](LICENSE)
