# IMPLEMENTATION STATUS — AI Repeat MVP

آخر تحديث: 2026-11-08. هذه الوثيقة تُحدَّث مع كل مرحلة، وبتقول اللي اتنفذ فعلًا واللي لأ — من غير مبالغة.

## What actually works right now (verified by running)

- **Agent service** (loopback `127.0.0.1:8757`): session-token auth, strict origin check, no CORS headers, SSE live events.
- **Task engine**: queue (concurrency 2), full state machine (`queued → running → awaiting_approval | paused → completed | failed | cancelled`), per-step timeline, bounded retries for idempotent steps only, pause/resume/cancel with AbortController, wall-clock budget.
- **Browser executor** (app-owned Chromium via Playwright, ephemeral isolated contexts): typed tools `navigate / click / fill / select / wait_visible / extract_table / download / export_csv / request_approval`. Network-level domain guard aborts every request outside `allowedDomains`. Secret fields (password/OTP/card) are never filled or recorded.
- **Verification engine** (deterministic, independent of any model): `url_matches`, `element_visible`, `file_exists`, `table_row_count`, `text_contains` (page or workspace file).
- **Approvals**: `external_write`/`high_impact` always pause; approval binds to a SHA-256 action fingerprint — mutated arguments are rejected (`FINGERPRINT_MISMATCH`) and need fresh consent; 10-minute expiry.
- **Demo workflows G1 + G2** run end-to-end over HTTP with real Chromium (see "Commands actually run").
- **Tauri v2 desktop shell** (`apps/desktop/src-tauri`): WebView2 window over the Arabic RTL UI, **session token delivered via IPC** (`get_session_token` command — never the network), agent health command, and dev auto-spawn of the agent (`npm run agent`) when not listening. CSP restricted to self + loopback agent origin. Run with `npm run app` (Tauri dev), package with `npm run app:build` (NSIS installer target).
- **Agent sidecar (Node SEA)**: `npm run agent:sidecar` bundles the whole agent (express + zod + playwright-core) into one CJS file with esbuild — including a patch that inlines playwright's dynamic `browsers.json`/`package.json` requires — then injects it into a copy of `node.exe` (postject + sentinel fuse) producing a standalone `ai-repeat-agent.exe`, placed as the Tauri `externalBin`. **Verified end-to-end**: the standalone exe boots, seeds embedded demo workflows, and completes a G1 run with real Chromium.
- **First-run Chromium install (explicit consent)**: `GET /api/browser/status` + `POST /api/browser/install` — downloads the exact Chrome-for-Testing build pinned by our playwright-core (revision from inlined metadata) into the standard ms-playwright cache via PowerShell extraction, with size caps, throttled SSE progress events, and honest failures. `browserAvailable` re-resolves dynamically so tasks work immediately after install. UI: consent card + progress bar in الإعدادات. **Tested with a local fake mirror serving a real zip (no network in tests).**
- **Artifact download**: `GET /api/artifacts?path=…` streams run outputs (CSV/JSON/PNG) from inside the approved workspace only — traversal/absolute paths refused (S07 test), surfaced as a download button in task details.
- **Token budget enforcement**: every task's provider calls pass through a budget wrapper — provider-reported usage accumulates per task and crossing `budgets.maxTokensPerRun` fails the task loudly (`TOKEN_BUDGET_EXCEEDED`) instead of burning silently. Usage rows land in SQLite and `usage.reported` events stream to the UI.
- **Retry as new run**: failed/cancelled tasks can be retried (`POST /api/tasks/:id/retry` + UI button). It never resumes blindly — it creates a fresh run with the same non-secret inputs; tasks whose secret inputs were redacted are refused with `SECRET_INPUT_LOST`.
- **Pause/resume across restarts**: paused tasks survive app restarts (only mid-flight ones are failed honestly at boot) and resume from their last verified checkpoint — passed steps are skipped, outputs restored, in a fresh browser context. **Prerequisite fixed**: step states are now persisted *live* via a new executor `onStepUpdate` hook — previously steps only hit the DB at task end, so the task timeline stayed empty while running and no checkpoint existed. The HTTP E2E test pauses mid-run, resumes, and proves steps a/b were not re-executed (attempt counts) while c ran.
- **Screenshot-on-failure evidence (opt-in)**: `saveScreenshots` setting (default off, toggle in الإعدادات) captures a page screenshot into `workspace/evidence/<taskId>/` on step failure; the step record references it. Never the user's desktop.
- **Retention enforcement (S11)**: an hourly job (and boot pass) physically deletes evidence files older than `retentionDays` from the app workspace only.
- **Concurrent tasks verified**: two G1 tasks complete simultaneously under `maxConcurrentTasks: 2` (FR-05 test).
- **Teach Mode (P1 subset)**: visible agent-owned browser with persistent profile leasing, records navigate/click/fill/select, redacts sensitive fields into manual checkpoints, produces an editable draft workflow; UI page to review/save. **Automated G3 E2E now covers it**: record → draft → replay twice with different values; password/OTP values provably never captured.
- **Structured step editor (no-code review, FR-03)**: the draft review is now editable cards, not raw JSON — variable renaming rewrites `{{refs}}` everywhere, values can be converted to new variables (datalist of existing ones), steps are deletable, summaries editable, verification rules addable/removable with a type picker, and recorder-only artifacts (`locator.uncertain`, `_meta`) are stripped on save with per-step warnings. Ghost variables block saving with a clear message; an advanced JSON editor remains behind a toggle. Logic lives in `apps/desktop/src/lib/step-editor.ts` (pure, 9 unit tests).
- **Skill editing + export/import**: the same editor edits saved skills from مهاراتي (fix a stale locator, adjust a summary — save bumps the workflow version). `GET /api/workflows/:id/export` serves a redacted JSON attachment; `POST /api/workflows/import` **never overwrites** a colliding local skill — it lands under a fresh suffixed id (`…-i1`) and reports the rename. Roundtrip + collision tests included.
- **Repair by re-recording from the failed step**: a failed step in the task timeline offers «سجّل من هنا» — opens the agent browser at the failed step's recorded URL, the user re-performs from that point, and the recording is merged into the original workflow (steps before the failure kept, colliding variables renamed `rep1…` with refs rewritten, recorded step ids re-numbered) straight into the review editor. Merge logic is pure + unit-tested (`mergeRepair`).
- **Task output preview + evidence viewer**: exported CSVs render inline (first 10 rows, real parser handling BOM/quotes/CRLF — pure + unit-tested in `lib/csv.ts`), with a download button for the full file; failed steps with opt-in screenshots show a «لقطة الفشل» link served sandbox-checked from the workspace. Skills page has a search box (name/id/description).
- **Recurring tasks (schedules, P1)**: per-skill schedules (`interval everyMinutes` or `daily atHHMM`) stored in SQLite (migration v2), fired by a 20s in-process scheduler through the normal TaskManager — approvals, allowlists, verification and budget all apply identically. No pile-up: a schedule delays 1 minute while its workflow has an active task; missing-skill and failed-creation schedules disable themselves with an honest note. Runs only while the app is open (documented; no cloud worker in MVP). UI: scheduling section in each skill card + «الجداول القادمة» on الرئيسية. `nextDue` is pure + unit-tested (interval, daily across midnight); scheduler fires/skip/disable paths tested.
- **Pilot KPIs (spec docs/07)**: `verified_success_rate`, `avg_run_seconds`, `approvals_per_run`, `tokens_per_verified_run` computed server-side from real local data only (never invented) and shown on الرئيسية when a denominator exists.
- **Voice (FR-06, feature-flagged)**: push-to-talk in المساعد via the window's Web Speech engine with an **honest availability check** (the button only appears when the engine exists); optional TTS task summaries using **local Windows voices** (Arabic voice count shown in الإعدادات). SSE now distinguishes `replay` from `task` events so TTS never speaks historical events. No always-on listening; flags live in localStorage only. Voice STT engine choice (local whisper vs cloud) remains founder decision #4 — the Web Speech path works without any download.
- **Visual UI audit (browser automation)**: every page (الرئيسية/المساعد/علّمني مهمة/مهاراتي/المهام/الإعدادات) was opened, screenshotted and exercised in a real browser. **Found and fixed a critical dev-mode bug**: the Vite dev proxy was configured at the wrong config level (`proxy` instead of `server.proxy`), so the dev UI silently received `index.html` instead of API JSON — a blank page with an undefined-property crash in Home. The packaged app was never affected (same-origin serving), which is why all backend tests passed. The audit verified live: RTL layout, KPI cards with real values, task timeline with repair/retry buttons, schedule section, voice availability display (1 Arabic voice installed on this machine), and the honest offline fallback (MISSING_API_KEY) in المساعد.
- **Live UI flow verification**: G1 was run end-to-end from the UI (timeline updates live, verification report renders, CSV preview shows the 4 real rows); G2's approval dialog was exercised in the browser — exact payload display, high-risk red button per spec, **ESC closes the dialog and it legitimately re-appears (a mandatory checkpoint cannot be skipped by closing the window)**, then approval → completion with full report. **Two fixes from this**: the dialog re-show logic (previously ESC hid a pending approval forever, leaving the run stuck) and the task state now honestly shows `awaiting_approval` while paused at the gate (previously stayed "running").
- **Desktop notifications**: optional, permission-gated (Web Notification API, works in WebView2 + browser), off by default, toggled from الإعدادات — designed for scheduled runs; nothing fires before opt-in.
- **Workflow version history (FR-03 completed)**: every save lands in `workflow_versions` (SQLite migration v3). API: `GET /api/workflows/:id/versions` + `POST /api/workflows/:id/restore` — restoring a snapshot creates a NEW version (never destructive). UI: «النسخ السابقة» section in each skill card with one-click rollback. Unit-tested (history, rollback-as-new-version, unknown ids).
- **Configurable STT engines (FR-06 architecture completed)**: `stt.engine` = `web-speech` (default, zero install) | `whisper-local` | `none`. For `whisper-local` the founder drops their own whisper.cpp `.exe` + ggml model and sets both paths in settings — **no download is ever performed by the app**; `POST /api/stt/transcribe` runs the CLI on a recorded wav (size-capped, temp-cleaned, Arabic by default) and parses the transcript. Non-.exe binaries are refused (no shell-spawn hazards). Guard paths + parser unit-tested; the real-CLI integration requires the founder's binary.
- **AI-drafted workflows (المساعد → مسودة → مراجعة)**: `POST /api/workflows/draft-from-plan` — the model drafts a candidate workflow from an Arabic description, **WorkflowSchema validates it server-side, and it is NEVER auto-saved**: the draft opens in the structured editor for human review, then the normal save flow applies (approvals still enforced at runtime). Invalid model output → `DRAFT_INVALID` with the exact schema issues, state untouched. Tested with a canned mock provider (valid + invalid paths).
- **Windows UIA — Phase-5 STEP 1 shipped (read-only, feature-flagged)**: `services/agent/src/uia.ts` + `/api/uia/windows|inspect|flag`. Lists top-level windows and dumps up to 60 UIA properties per chosen window (name/type/enabled/offscreen) via the .NET UIAutomation client that ships with Windows. **E2E-tested against real Notepad** (window listed, Document/Edit controls found, Descendants scope for modern WinUI hosts, PS 5.1 hashtable rules respected).
- **Windows UIA — Phase-5 STEP 2 shipped (InvokePattern, measured)**: `POST /api/uia/invoke {hwnd, index}` executes **InvokePattern only**, addressed by the exact descendant index the inspector showed the user (stale index → honest refusal). Requires progressive gating (read-only first, then patterns). Server logs every attempt. **Measured E2E on real Notepad**: invoking «Add New Tab» increased the observable TabItem count through a fresh inspection; non-invocable controls (Pan) are refused with `UIA_NOT_INVOKABLE`. No SendInput / no physical mouse or keyboard injection exists anywhere. Value/Toggle/Selection patterns and per-app adapters remain future work (each is its own measured milestone).
- **True restart-resume E2E**: two REAL agent processes sharing one dataDir — boot #1 runs, pauses at a checkpoint, gets **hard-killed**; boot #2 finds the task still `paused` (not failed), resumes, and completes with checkpoint-skip proof (a/b attempt counts stay 1). This is the strongest possible proof of the pause-across-restart claim.
- **Known incident (honest)**: in one packaged-sidecar boot, the event loop stalled ~7 minutes right after queuing the first task, then self-recovered and everything completed. Most plausible cause: antivirus scanning the freshly-built Chromium path on first launch. Mitigation shipped: a `بدء التنفيذ` log event now fires the moment execution begins, so a stalled launch is visible in the timeline instead of a silent eternal "queued".
- **Global stop (FR-05)**: `POST /api/tasks/stop-all` + a red «⛔ إيقاف الكل» button in the sidebar — cancels every active task and prevents scheduling any new action, exactly as the spec's "Global Stop button" requires.
- **Workspace backup/restore (FR-07 completed)**: `GET /api/backup` exports a full bundle (workflows + version history + tasks + schedules, **with an explicit contents/excluded disclosure** — secrets never leave the DPAPI vault, browser profiles never leave the machine). `POST /api/backup/restore` re-imports with safety rules: colliding skill ids are renamed (`-r1…`, never overwritten), **schedules always arrive disabled**, archived tasks are view-only history. UI in الإعدادات: download + file restore. Roundtrip + collision + non-backup-file tests.
- **History delete + full retention (FR-07)**: `DELETE /api/history` + «امسح السجل» button in سجل التنفيذ (tasks/workflows/schedules untouched); retention now trims **all** event types older than the window instead of only log lines.
- **Orphaned browser cleanup (spec: graceful cleanup)**: the agent records the PID of every Chromium it launches; on boot, PIDs from previous sessions that are still alive **and** whose executable path is inside the ms-playwright cache are killed. Third-party browsers are never touched (PID self-tracking + path double-check). Wired into task runs and Teach sessions.
- **Arabic RTL desktop UI** (React + Vite): الرئيسية / المساعد / علّمني مهمة / مهاراتي / المهام / سجل التنفيذ / الإعدادات؛ live SSE updates; approval dialog; connection test; settings (model, key, budgets); debug-log export (redacted).
- **GLM-5.3-flash adapter**: OpenAI-compatible, configurable base URL/model/timeout, retries with exponential backoff + jitter, no-retry on 401/403, usage metering into SQLite, connection test with exact error reasons, invalid-model-JSON surfaced (never silently accepted), offline fallback clearly labeled (never fakes a model success).
- **Storage**: SQLite (`node:sqlite`, zero native deps) with a migration runner; secrets only in a DPAPI vault (Windows Credential Manager scope) — never in DB/settings/logs.
- **Retention**: retention setting present; screenshots are opt-in and **off by default**; event log entries are redacted at write time.

## Commands actually run (this machine, Windows 10 · Node 24.18)

| Command | Result |
|---|---|
| `npm install` | OK (workspaces; playwright-core + express + zod + vitest) |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors (backend + tests) |
| `cd apps/desktop && npx tsc --noEmit` | 0 errors |
| `npx vite build` (apps/desktop) | OK — `dist/` built |
| `npx vitest run` | **122/122 passed** (17 files) |
| UIA read-only E2E (real Notepad) | ✓ — windows listed, controls dumped, input-injection absent by design |
| UIA InvokePattern E2E (real Notepad) | ✓ — Add-Tab invoked, tab count measurably increased; non-invocable refused |
| Visual UI audit (in-app browser) | ✓ — all 7 pages screenshotted & exercised; fixed vite dev proxy misconfiguration; RTL/layout/flows verified live |
| Live UI flows (in-app browser) | ✓ — G1 run+timeline+CSV preview; G2 approval dialog (ESC re-show + approve → completed); fixes: dialog re-show, awaiting_approval task state |
| Restart-resume E2E (two real processes) | ✓ — pause → hard kill → boot #2 → resume → completed with checkpoint skip |
| Packaged sidecar re-verification (17:21 build) | ✓ — stop-all, history delete, versions endpoints + G1 run through the bundled sidecar; one 7-min first-launch stall observed & documented (see incident above) |
| `cargo check` / `cargo build` (apps/desktop/src-tauri) | ✓ — Rust 1.99.1 MSVC; debug exe `ai-repeat-desktop.exe` built |
| Launch `ai-repeat-desktop.exe` | ✓ — window opens (Arabic title), auto-spawns the agent, G1 completes 4/4 + verifications through the shell-spawned agent; token via IPC command |
| `npm run agent:sidecar` | ✓ — esbuild bundle (playwright metadata inlined) + Node SEA exe + placed as Tauri externalBin |
| SEA exe standalone | ✓ — boots, seeds embedded workflows, G1 completed 4/4 with real Chromium |
| `npm run app:build` | ✓ — release build + **NSIS installer** `AI Repeat_0.1.0_x64-setup.exe` (~25 MiB, rebuilt with the installer + artifact endpoints) |
| Release exe (no dev agent running) | ✓ — spawned the bundled sidecar itself, production data dir `%APPDATA%\AIRepeat`, G1 completed 4/4 + verifications, `browser/status` + artifact download live |
| `npm run agent` | boots, serves API + built UI, seeds 2 workflows, starts fixture site |
| `npm run smoke` | G1 completed with 4/4 verifications ✓ |
| Live HTTP demo | G1 completed (4/4 steps, verifications ✓, CSV written); G2 paused at approval → wrong fingerprint rejected → correct fingerprint → completed, draft visible on fixture; retry endpoint refuses completed tasks with a clear Arabic error |

## Test coverage mapped to the acceptance matrix (acceptance matrix)

- G1 gold path (filter/extract/export/verify) — executor E2E + HTTP E2E ✓
- G2 approval flow (reject ⇒ no submit; approve ⇒ verified confirmation; dedupe) ✓
- G3 recorder — **automated E2E**: record → editable draft → replay twice with different values; password/OTP never captured (S03) ✓
- D/G5 cancellation — executor + HTTP tests; cancel under 3s for *new* actions ✓
- S01 injection neutrality ✓ (S02 network-guard test proves no exfil request possible)
- S02 domain allowlist (executor + network layer) ✓
- S03 secret-field redaction (fill guard + recorder skip + redactValue) ✓
- S04 code-level tool allowlist (schema rejects unknown actions; executor default case throws) ✓
- S05 approval fingerprint binding ✓ (HTTP test)
- S06 profile leasing ✓ (mutex test)
- S07 path sandbox ✓ (traversal + absolute escape)
- S08 cancel mid-flight → no later step executes ✓ (D/G5)
- S09 missing/bad key → clear diagnostic, no retry loop ✓ (unit test)
- S12 invalid input → validation errors, no crash ✓
- S10 CAPTCHA/MFA bypass — **not implementable by design**: no tool exists for it; documented.
- S11 retention expiry — hourly + boot cleanup job physically deletes expired evidence files; retention setting patchable via API/UI ✓ (log-event trimming partial)
- **Token budget cap enforced per run** (provider-reported usage only) ✓ unit tested
- **S07 for artifacts** — the artifact endpoint refuses traversal/absolute paths outside the workspace ✓ (live + unit tested)
- G4 (user types elsewhere while task runs) — Playwright runs headless/separate window by design; manual verification on Windows pending (needs a human at the keyboard).

## Deliberately deferred (honest list)

- **Code signing**: the installer/exe are unsigned — Windows SmartScreen will warn on first run until a certificate signs them (founder decision).
- **Voice (P1)**: feature-flagged off; no always-on listening anywhere.
- **Windows UIA / desktop automation (P2)**: not started — per spec it must stay out of MVP.
- **Multi-window concurrency dashboard**: the engine runs 2 tasks concurrently (tested); the UI shows them as a list, not a multi-window viewer.
- **Retry-from-checkpoint mid-run**: checkpoint id is tracked; retry creates a fresh run (side-effect-safe by design).

## Robustness round (2026-11-08)

5. **التشغيل المزدوج كان بيبوظ البيانات** — نسختين من التطبيق على نفس dataDir: إقلاع التانية كان بيفشل مهام الأولى النشطة (stale recovery). Fixed: `agent.lock` بـPID — نسخة ثانية ومالكها حي = رفض برسالة عربية واضحة؛ lock يتيم من كراش = takeover آمن. E2E بعملية أجنبية حية.
6. **مقارنة التوكن كانت `!==`** — حساسة لتوقيت القياس نظريًا. Fixed: `crypto.timingSafeEqual` بعد فحص طول.
7. **Load drain مُقاس**: 10 مهام متزامنة على fixture حقيقي → كلها completed بدون state corruption (وكان بتكشف خطأ seeding في الاختبار نفسه أصلًا).

## Review round 2 (2026-11-08) — cancel-during-approval bug fixed

4. **إيقاف مهمة واقفة عند الموافقة كان مش فوري** — cancel أثناء `awaiting_approval` ما كانش بيأثر على الـwait (المهمة تفضل عالقة لحد ما المستخدم يحسم أو تنتهي صلاحيتها بعد 10 دقايق)، وكانت ممكن تطلع `failed` (APPROVAL_REJECTED) بدل `cancelled`. Fixed: abort signal يوصل لبوابة الموافقة (settle فوري كرفض) + الـexecutor يفرّق بين رفض بشرية وإلغاء (cancelled semantics). E2E: cancel → cancelled في <10s بدون تدخل بشرية، والموافقة اتقفلت من pending. Minor: teach browser PID بيتـuntrack عند الإغلاق النظيف.

## Self-review round (2026-11-08) — 3 real bugs found & fixed

1. **stop-all left queued tasks alive** — cancelAll aborted active tasks but the queue drained into execution right after the 100ms stop window (direct FR-05 violation). Fixed: stop-all now drains the queue (queued → cancelled) and aborts active; the stop window still re-pumps legitimately queued tasks created *during* it. Test extended: 2 running + 1 queued → all three end `cancelled`.
2. **50MB body limit was 1MB** — `/api/stt/transcribe` (real 30s+ wav clips) and `/api/backup/restore` (large workspaces) could never receive their payloads; the STT test passed only because its fake wav was tiny. Fixed: `express.json({ limit: "50mb" })` on the loopback-only API.
3. **Backup exported at most 200 tasks** (`listTasks` UI cap leaked into the export) while the bundle claims full portability. Fixed: dedicated `listAllTasks()` (no limit) used by the backup endpoint only.

## Known platform limitations (documented, not hidden)

- Tasks run only while the machine is on; no cloud worker.
- Sites requiring CDN assets need those domains in the allowlist (the guard blocks everything unapproved, on purpose).
- GLM endpoint/subscription semantics (the "500M tokens" claim) remain **unverified** — the app treats quota as unknown and shows real provider-reported usage only.

## Security review summary

- Key storage: DPAPI (`CurrentUser`) via PowerShell; file contains no plaintext; dev fallback (non-Windows) is marker-flagged base64.
- No shell/exec tools exist anywhere in the tool registry; no `eval`/`Function` in agent code paths.
- Downloads/exports: filename sanitized, path sandboxed, CSV-only guard for `export_csv`.
- Logs/DB/events: redaction at write time (`redactValue`); approval payloads mask secret inputs.
- Loopback only; random per-session token; foreign Origin rejected; no CORS headers.

## Next technical tasks (in order)

1. Real-key Z.ai integration smoke test (needs the founder's key via Settings UI).
2. Code signing certificate for the installer (founder decision).
3. Optional: dedicated local STT engine (whisper download) if the Web Speech engine proves insufficient for Arabic accents — needs the STT decision (#4 in spec open questions).
