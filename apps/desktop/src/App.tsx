import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, eventStreamUrl, initToken, type ApprovalView, type Bootstrap } from "./api.js";
import Home from "./pages/Home.js";
import Assistant from "./pages/Assistant.js";
import Teach from "./pages/Teach.js";
import Skills from "./pages/Skills.js";
import Tasks from "./pages/Tasks.js";
import Logs from "./pages/Logs.js";
import SettingsPage from "./pages/Settings.js";
import { buildTaskSummaryText, speak, ttsAvailable, voiceFlags } from "./lib/voice.js";
import { notifyTask } from "./lib/notify.js";
import ErrorBoundary from "./components/ErrorBoundary.js";
import { t, applyDirection, type Lang, type StringKey } from "./lib/i18n.js";
import type { TaskEvent } from "./types.js";

type PageKey = "home" | "assistant" | "teach" | "skills" | "tasks" | "logs" | "settings";

const NAV: Array<{ key: PageKey; label: string }> = [
  { key: "home", label: "nav.home" as StringKey },
  { key: "assistant", label: "nav.assistant" as StringKey },
  { key: "teach", label: "nav.teach" as StringKey },
  { key: "skills", label: "nav.skills" as StringKey },
  { key: "tasks", label: "nav.tasks" as StringKey },
  { key: "logs", label: "nav.logs" as StringKey },
  { key: "settings", label: "nav.settings" as StringKey },
];

interface AppState {
  boot: Bootstrap | null;
  refresh: () => Promise<void>;
  events: TaskEvent[];
  connected: boolean;
  error: string | null;
  openTasksPage: (taskId?: string) => void;
  lang: Lang;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error("[AI Repeat] App crash:", error.message);
  }
  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: "sans-serif", direction: "rtl" }}>
          <h1>AI Repeat</h1>
          <div style={{ background: "#fdeceb", border: "1px solid #f5c6cb", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            حدث خطأ غير متوقع — اضغط إعادة التشغيل.
            <br />
            <code style={{ fontSize: 12 }}>{(this.state.error as Error)?.message.slice(0, 300)}</code>
          </div>
          <button
            style={{ padding: "10px 24px", background: "#1264a3", color: "white", border: 0, borderRadius: 8, cursor: "pointer", fontSize: 16 }}
            onClick={() => this.setState({ error: null })}
          >
            إعادة التشغيل
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<PageKey>("home");
  const [focusTask, setFocusTask] = useState<string | undefined>(undefined);
  const [approval, setApproval] = useState<ApprovalView | null>(null);

  const refresh = useCallback(async () => {
    try {
      const b = await api.bootstrap();
      setBoot(b);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await initToken();
      await refresh();
      const es = new EventSource(eventStreamUrl());
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      const handle = (m: MessageEvent, live: boolean) => {
        try {
          const ev = JSON.parse(m.data) as TaskEvent;
          setEvents((prev) => [...prev.slice(-500), ev]);
          if (!live) return; // replayed history never triggers side effects (e.g. TTS)
          if (ev.event === "approval.requested") void refresh();
          if (ev.event === "task.completed" || ev.event === "task.failed" || ev.event === "task.cancelled") {
            void refresh();
            // Optional desktop notification (permission-gated, off by default).
            const wfName = String((ev.data as { workflowName?: string } | undefined)?.workflowName ?? "المهمة");
            notifyTask(ev.event, wfName, ev.taskId);
            // Optional voice summary (feature-flagged, off by default).
            if (ttsAvailable() && voiceFlags.ttsEnabled()) {
              const name = String((ev.data as { workflowName?: string } | undefined)?.workflowName ?? "المهمة");
              const verificationPassed = ev.data?.verificationPassed as boolean | undefined;
              const line = buildTaskSummaryText(
                ev.event === "task.completed" ? "completed" : ev.event === "task.failed" ? "failed" : "cancelled",
                name,
                verificationPassed,
              );
              speak(line);
            }
          }
        } catch {
          /* ignore malformed */
        }
      };
      es.addEventListener("replay", (m) => handle(m as MessageEvent, false));
      es.addEventListener("task", (m) => handle(m as MessageEvent, true));
      return () => es.close();
    })();
  }, [refresh]);

  // Poll pending approvals while anything is awaiting approval. A dismissed
  // dialog (ESC) legitimately re-appears — a mandatory checkpoint cannot be
  // skipped by closing the window.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const { approvals } = await api.pendingApprovals();
        if (approvals.length > 0) setApproval((cur) => cur ?? approvals[0]);
        else setApproval((cur) => (cur ? null : cur));
      } catch {
        /* agent restarting */
      }
    }, 1500);
    return () => clearInterval(t);
  }, []);

  const openTasksPage = useCallback((taskId?: string) => {
    setFocusTask(taskId);
    setPage("tasks");
  }, []);

  const lang: Lang = boot?.settings?.language === "en" ? "en" : "ar";
  useEffect(() => applyDirection(lang), [lang]);
  const state: AppState = { boot, refresh, events, connected, error, openTasksPage, lang };

  return (
    <AppErrorBoundary>
    <Ctx.Provider value={state}>
      <div className="app">
        <nav className="sidebar" aria-label="التنقل الرئيسي">
          <div className="brand">AI Repeat</div>
          {NAV.map((n) => (
            <button key={n.key} className={page === n.key ? "active" : ""} onClick={() => setPage(n.key)}>
              {t(lang, n.label as StringKey)}
            </button>
          ))}
          <div className="spacer" />
          <button
            className="danger"
            style={{ margin: "6px 4px" }}
            onClick={async () => {
              try {
                const r = await api.stopAllTasks();
                await refresh();
                if (r.cancelledActive > 0) window.alert(`تم إيقاف ${r.cancelledActive} مهمة فورًا.`);
              } catch {
                /* best effort */
              }
            }}
            title="يوقف كل المهام الشغالة والمعلقة فورًا (FR-05)"
          >
            ⛔ إيقاف الكل
          </button>
          <div className="status">{connected ? t(lang, "nav.connected") : t(lang, "nav.disconnected")}</div>
        </nav>
        <main className="main">
          {error && <div className="notice bad">خطأ في الاتصال بالخدمة المحلية: {error}</div>}
          {page === "home" && <ErrorBoundary pageName="الرئيسية" onRecover={() => setPage("home")}><Home lang={lang} /></ErrorBoundary>}
          {page === "assistant" && <ErrorBoundary pageName="المساعد" onRecover={() => setPage("home")}><Assistant lang={lang} /></ErrorBoundary>}
          {page === "teach" && <ErrorBoundary pageName="علّمني مهمة" onRecover={() => setPage("home")}><Teach lang={lang} /></ErrorBoundary>}
          {page === "skills" && <ErrorBoundary pageName="مهاراتي" onRecover={() => setPage("home")}><Skills lang={lang} /></ErrorBoundary>}
          {page === "tasks" && <ErrorBoundary pageName="المهام" onRecover={() => setPage("home")}><Tasks lang={lang} focusTaskId={focusTask} /></ErrorBoundary>}
          {page === "logs" && <ErrorBoundary pageName="سجل التنفيذ" onRecover={() => setPage("home")}><Logs lang={lang} /></ErrorBoundary>}
          {page === "settings" && <ErrorBoundary pageName="الإعدادات" onRecover={() => setPage("home")}><SettingsPage lang={lang} /></ErrorBoundary>}
        </main>
        {approval && <ApprovalDialog approval={approval} onClose={() => setApproval(null)} />}
      </div>
    </Ctx.Provider>
    </AppErrorBoundary>
  );
}

function ApprovalDialog({ approval, onClose }: { approval: ApprovalView; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const highRisk = approval.risk === "external_write" || approval.risk === "high_impact";
  const rejectRef = useRef<HTMLButtonElement>(null);

  // Accessibility (spec: ESC closes the dialog, focus moves to the safe action).
  useEffect(() => {
    rejectRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resolve = async (approve: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api.resolveApproval(approval.id, approve ? "approve" : "reject", approval.detail.fingerprint as string | undefined);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="dialog">
        <h3 id="approval-title">محتاج موافقتك قبل الخطوة دي</h3>
        <p>
          <strong>{approval.title}</strong>
        </p>
        <ul style={{ color: "var(--muted)", lineHeight: 1.7 }}>
          <li>
            النطاق: <code>{String(approval.detail.url ?? "—")}</code>
          </li>
          <li>تصنيف الخطوة: {RISK_AR[approval.risk] ?? approval.risk}</li>
          {approval.detail.rowsCount !== undefined && <li>عدد الصفوف المعنية: {String(approval.detail.rowsCount)}</li>}
        </ul>
        <pre>{JSON.stringify(approval.detail, null, 2)}</pre>
        {highRisk && (
          <p style={{ color: "var(--bad)" }}>
            خطوة خارجية قد تحدث أثرًا على موقع حقيقي — اتأكد من التفاصيل قبل الموافقة.
          </p>
        )}
        {err && <div className="notice bad">{err}</div>}
        <div className="actions">
          <button ref={rejectRef} className="ghost" onClick={() => resolve(false)} disabled={busy}>
            رفض
          </button>
          <button
            className={highRisk ? "danger" : "primary"}
            onClick={() => resolve(true)}
            disabled={busy}
          >
            موافق على الخطوة دي
          </button>
        </div>
      </div>
    </div>
  );
}

export const RISK_AR: Record<string, string> = {
  read: "قراءة فقط",
  local_write: "كتابة محلية",
  external_write: "إرسال خارجي",
  high_impact: "أثر عالي (حذف/دفع/تعديل جماعي)",
};

export const STATE_AR: Record<string, string> = {
  queued: "في الطابور",
  planning: "تخطيط",
  running: "قيد التنفيذ",
  awaiting_approval: "بانتظار موافقتك",
  paused: "متوقفة مؤقتًا",
  recovering: "استرجاع",
  verifying: "قيد التحقق",
  completed: "مكتملة",
  failed: "فشلت",
  cancelled: "ملغاة",
};
