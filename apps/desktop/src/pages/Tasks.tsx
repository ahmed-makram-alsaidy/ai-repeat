import { useCallback, useEffect, useState } from "react";
import { STATE_AR, useApp } from "../App.js";
import { api, type TaskDetail, type TaskSummary } from "../api.js";
import WorkflowEditor from "../components/WorkflowEditor.js";
import { mergeRepair, parseDraft, type DraftWorkflow } from "../lib/step-editor.js";
import { csvPreview, type CsvPreview } from "../lib/csv.js";
import { t, type Lang } from "../lib/i18n.js";

function ArtifactCsvPreview({ path }: { path: string }) {
  const [state, setState] = useState<{ loading: boolean; preview?: CsvPreview; error?: string }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const text = await api.fetchArtifactText(path);
        if (!cancelled) setState({ loading: false, preview: csvPreview(text, 10) });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (state.loading) return <p className="sub">جاري قراءة الملف…</p>;
  if (state.error) return <p className="fail">{state.error}</p>;
  const p = state.preview!;
  return (
    <div>
      <table className="list" style={{ marginBottom: 8 }}>
        <thead>
          <tr>
            {p.headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r, ri) => (
            <tr key={ri}>
              {p.headers.map((_, ci) => (
                <td key={ci}>{r[ci] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">
        أول {p.rows.length} صف من {p.totalRows}
        {p.truncated ? " — نزّل الملف للعرض الكامل." : ""}
      </p>
    </div>
  );
}

const STEP_MARK: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  running: "…",
  awaiting_approval: "؟",
  pending: "·",
  skipped: "–",
  cancelled: "✗",
};

export default function Tasks({ focusTaskId, lang }: { focusTaskId?: string; lang: Lang }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>(focusTaskId);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { events, connected } = useApp();
  const [repair, setRepair] = useState<{ failedStepId: string; url: string } | null>(null);
  const [repairWf, setRepairWf] = useState<DraftWorkflow | null>(null);
  const [repairNote, setRepairNote] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const r = await api.tasks();
      setTasks(r.tasks);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api.task(id);
      setDetail(r.task);
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void loadList();
    if (selected) void loadDetail(selected);
  }, [loadList, loadDetail, selected]);

  useEffect(() => {
    if (focusTaskId) setSelected(focusTaskId);
  }, [focusTaskId]);

  // Live refresh on relevant events.
  useEffect(() => {
    const relevant = events.slice(-8);
    const last = relevant.at(-1);
    if (!last) return;
    void loadList();
    if (selected && last.taskId === selected) void loadDetail(selected);
  }, [events, loadList, loadDetail, selected]);

  const act = async (id: string, action: "pause" | "resume" | "cancel") => {
    try {
      await api.taskAction(id, action);
      await loadList();
      await loadDetail(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const retry = async (id: string) => {
    try {
      const { task } = await api.retryTask(id);
      await loadList();
      setSelected(task.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /** Resume-from URL for a failed step: its own evidence URL, or the last passed step's. */
  const repairUrlFor = (failedIdx: number): string | null => {
    if (!detail) return null;
    const candidates = [detail.steps[failedIdx], ...detail.steps.slice(0, failedIdx).reverse()];
    for (const s of candidates) {
      const url = s?.evidence?.currentUrl;
      if (typeof url === "string" && url.startsWith("http")) return url;
    }
    return null;
  };

  const startRepair = async (failedStepId: string) => {
    if (!detail) return;
    setErr(null);
    setRepairNote(null);
    const idx = detail.steps.findIndex((s) => s.stepId === failedStepId);
    const url = repairUrlFor(idx);
    if (!url) {
      setErr("مفيش رابط محفوظ للخطوات دي — افتح الموقع يدويًا أو عدّل الـlocator من محرر المهارة.");
      return;
    }
    try {
      await api.teachStart(url);
      setRepair({ failedStepId, url });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const stopRepair = async () => {
    if (!repair || !detail) return;
    try {
      const r = await api.teachStop();
      const recorded = parseDraft(r.draft);
      if (!recorded.ok) throw new Error(recorded.error);
      const all = await api.workflows();
      const row = (all.workflows as Array<{ id: string; workflow: unknown }>).find((w) => w.id === detail.workflowId);
      if (!row) throw new Error(`المهارة ${detail.workflowId} مش موجودة`);
      const original = parseDraft(JSON.stringify(row.workflow));
      if (!original.ok) throw new Error(original.error);
      const { wf: merged, warnings } = mergeRepair(original.wf, repair.failedStepId, recorded.wf);
      setRepair(null);
      setRepairWf(merged);
      setRepairNote(
        warnings.length > 0
          ? `اتدمج التسجيل الجديد مكان الخطوة الفاشلة. ملاحظات: ${warnings.join(" • ")}`
          : "اتدمج التسجيل الجديد مكان الخطوة الفاشلة — راجع واحفظ.",
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (selected && detail) {
    return (
      <div>
        <button className="ghost small" onClick={() => setSelected(undefined)}>
          ← كل المهام
        </button>
        <h1 style={{ marginTop: 10 }}>{detail.workflowName}</h1>

        {repair && (
          <div className="card">
            <p>
              <span className="rec-dot" /> جلسة إصلاح شغّالة من <span className="mono">{repair.url}</span> — نفّذ
              الخطوات من النقطة اللي فشلت في متصفح المساعد، وبعدين اضغط وقف التسجيل.
            </p>
            <button className="danger" onClick={() => void stopRepair()}>
              وقف التسجيل وادمج
            </button>
          </div>
        )}
        {repairWf && (
          <WorkflowEditor
            initialWf={repairWf}
            onSaved={async (id) => {
              setRepairWf(null);
              setRepairNote(`اتحفظت النسخة المُصلّحة من ${id} ✓ — شغّل المهمة تاني.`);
              await loadList();
              await loadDetail(detail.id);
            }}
            onCancel={() => setRepairWf(null)}
          />
        )}
        <div className="row" style={{ marginBottom: 14 }}>
          <span className={`state ${detail.state}`}>{STATE_AR[detail.state] ?? detail.state}</span>
          {detail.verificationsPassed !== null && (
            <span className="chip">{detail.verificationsPassed ? "التحقق نجح" : "التحقق فشل"}</span>
          )}
          <span className="chip">{detail.id}</span>
        </div>

        {err && <div className="notice bad">{err}</div>}
        {repairNote && <div className="notice ok">{repairNote}</div>}
        {detail.error && <div className="notice bad">{detail.error}</div>}

        <div className="row" style={{ marginBottom: 14 }}>
          <button className="ghost" onClick={() => act(detail.id, "pause")}>{t(lang, 'tasks.pauseBtn')}</button>
          <button className="ghost" onClick={() => act(detail.id, "resume")}>{t(lang, 'tasks.resumeBtn')}</button>
          <button className="danger" onClick={() => act(detail.id, "cancel")}>{t(lang, 'tasks.stopNow')}</button>
          {(detail.state === "failed" || detail.state === "cancelled") && (
            <button className="ghost" onClick={() => retry(detail.id)}>{t(lang, 'tasks.retry')}</button>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>{t(lang, "tasks.steps")}</h2>
          <ul className="timeline">
            {detail.steps.map((s) => (
              <li key={s.stepId}>
                <span className={`mark ${s.state === "passed" ? "pass" : s.state === "failed" ? "fail" : "pending"}`}>
                  {STEP_MARK[s.state] ?? "·"}
                </span>
                <span>{s.summary ?? s.action}</span>
                {s.attempt > 1 && <span className="chip">محاولة {s.attempt}</span>}
                {s.error && <span className="fail"> — {s.error.slice(0, 120)}</span>}
                {typeof s.evidence?.screenshot === "string" && (
                  <a href={api.artifactUrl(s.evidence.screenshot as string)} target="_blank" rel="noreferrer">
                    <button className="ghost small">{t(lang, 'tasks.shotOfFailure')}</button>
                  </a>
                )}
                {s.state === "failed" && !repair && !repairWf && (
                  <button className="ghost small" onClick={() => void startRepair(s.stepId)} title="افتح متصفح المساعد من النقطة دي وسجّل الخطوات من جديد">
                    سجّل من هنا
                  </button>
                )}
                <span className="t">
                  {s.durationMs !== undefined ? `${(s.durationMs / 1000).toFixed(1)}ث` : s.state === "running" ? "جارية" : ""}
                </span>
              </li>
            ))}
            {detail.steps.length === 0 && <li className="pending">لسه مفيش خطوات اتنفذت.</li>}
          </ul>
        </div>

        {detail.verifications.length > 0 && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>{t(lang, "tasks.verificationReport")}</h2>
            <ul className="timeline">
              {detail.verifications.map((v, i) => (
                <li key={i}>
                  <span className={`mark ${v.passed ? "pass" : "fail"}`}>{v.passed ? "✓" : "✗"}</span>
                  <span>
                    {v.kind} — {v.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {detail.usage && (detail.usage.inputTokens > 0 || detail.usage.outputTokens > 0) && (
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="chip">📥 {detail.usage.inputTokens} توكن دخل</span>
            <span className="chip">📤 {detail.usage.outputTokens} توكن خرج</span>
            <span className="chip">🔄 {detail.usage.requests} طلب للنموذج</span>
          </div>
        )}
        {Object.keys(detail.outputs).length > 0 && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>{t(lang, "tasks.results")}</h2>
            {typeof detail.outputs.export_path === "string" && (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <a href={api.artifactUrl(detail.outputs.export_path as string)} download>
                    <button className="ghost small">{t(lang, 'tasks.downloadOutput')}{detail.outputs.export_rows != null ? ` (${String(detail.outputs.export_rows)} صف)` : ""}</button>
                  </a>
                </div>
                {showPreview ? (
                  <ArtifactCsvPreview path={detail.outputs.export_path as string} />
                ) : (
                  <button className="ghost small" onClick={() => setShowPreview(true)}>
                    {t(lang, 'tasks.preview10')}
                  </button>
                )}
              </>
            )}
            <pre className="mono" style={{ whiteSpace: "pre-wrap", marginTop: 10 }}>
              {JSON.stringify(detail.outputs, null, 2)}
            </pre>
          </div>
        )}

        <div className="card">
          <h2 style={{ marginTop: 0 }}>{t(lang, "tasks.inputsSanitized")}</h2>
          <pre className="mono">{JSON.stringify(detail.inputs, null, 2)}</pre>
          {!connected && <p className="sub">التحديث الحي متوقف — الخدمة المحلية غير متصلة.</p>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>{t(lang, "tasks.title")}</h1>
      <p className="sub">{t(lang, "tasks.subtitle")}</p>
      {err && <div className="notice bad">{err}</div>}
      <table className="list">
        <thead>
          <tr>
            <th>{t(lang, 'tasks.col.task')}</th>
            <th>{t(lang, 'tasks.col.state')}</th>
            <th>{t(lang, 'tasks.col.steps')}</th>
            <th>{t(lang, 'tasks.col.verify')}</th>
            <th>{t(lang, 'tasks.col.created')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>{t.workflowName}</td>
              <td>
                <span className={`state ${t.state}`}>{STATE_AR[t.state] ?? t.state}</span>
              </td>
              <td>
                {t.stepsDone}/{t.stepsTotal || "—"}
              </td>
              <td>{t.verificationsPassed === null ? "—" : t.verificationsPassed ? "✓" : "✗"}</td>
              <td>{new Date(t.createdAt).toLocaleTimeString("ar-EG")}</td>
              <td>
                <button className="ghost small" onClick={() => setSelected(t.id)}>
                  عرض التفاصيل
                </button>
              </td>
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={6} className="sub">
                مفيش مهام لسه — شغّل مهارة من «مهاراتي».
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
