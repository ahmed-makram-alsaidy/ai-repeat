import { useState } from "react";
import { useApp } from "../App.js";
import { api } from "../api.js";
import { t, type Lang } from "../lib/i18n.js";

const EVENT_AR: Record<string, string> = {
  "task.started": "بدء مهمة",
  "task.completed": "اكتمال مهمة",
  "task.failed": "فشل مهمة",
  "task.cancelled": "إلغاء مهمة",
  "task.paused": "إيقاف مؤقت",
  "task.resumed": "استكمال",
  "step.started": "بدء خطوة",
  "step.verified": "خطوة تم التحقق منها",
  "step.failed": "فشل خطوة",
  "approval.requested": "طلب موافقة",
  "approval.resolved": "حسم موافقة",
  "verification.passed": "تحقق ناجح",
  "verification.failed": "تحقق فاشل",
  "usage.reported": "استهلاك توكنز",
  log: "سجل",
};

export default function Logs({ lang }: { lang: Lang }) {
  const { events, refresh } = useApp();
  const [cleared, setCleared] = useState<number | null>(null);
  return (
    <div>
      <h1>{t(lang, "logs.title")}</h1>
      <p className="sub">{t(lang, "logs.subtitle")}</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <a href={api.logsExportUrl()} download>
          <button className="ghost">{t(lang, "logs.export")}</button>
        </a>
        <button
          className="danger"
          onClick={async () => {
            if (!window.confirm("تمسح كل سجل التنفيذ؟ المهام نفسها هتفضل محفوظة.")) return;
            try {
              const r = await api.clearHistory();
              setCleared(r.cleared);
              refresh();
            } catch {
              /* best effort */
            }
          }}
        >
          امسح السجل
        </button>
        {cleared !== null && <span className="sub" style={{ margin: 0 }}>اتمسح {cleared} حدث ✓</span>}
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>{t(lang, 'logs.col.time')}</th>
            <th>{t(lang, 'logs.col.event')}</th>
            <th>{t(lang, 'logs.col.task')}</th>
            <th>{t(lang, 'logs.col.step')}</th>
            <th>{t(lang, 'logs.col.details')}</th>
          </tr>
        </thead>
        <tbody>
          {[...events].reverse().slice(0, 120).map((e, i) => (
            <tr key={i}>
              <td>{new Date(e.at).toLocaleTimeString("ar-EG")}</td>
              <td>{EVENT_AR[e.event] ?? e.event}</td>
              <td className="mono">{e.taskId.slice(0, 14)}…</td>
              <td className="mono">{e.stepId ?? "—"}</td>
              <td className="mono" style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.data ? JSON.stringify(e.data).slice(0, 120) : "—"}
              </td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={5} className="sub">
                مفيش أحداث بعد.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
