import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

interface ScheduleRow {
  id: string;
  workflowId: string;
  spec: { kind: string; everyMinutes?: number; atHHMM?: string };
  inputs: Record<string, string | number | boolean>;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastRunState?: string;
  lastRunError?: string;
}

export const SPEC_AR = (spec: ScheduleRow["spec"]): string =>
  spec.kind === "interval" ? `كل ${spec.everyMinutes} دقيقة` : `يوميًا الساعة ${spec.atHHMM}`;

/**
 * Recurring-run section inside a skill card (runs only while the app is open —
 * documented limitation; no cloud worker in the MVP).
 */
export default function ScheduleSection({ workflowId, onChanged }: { workflowId: string; onChanged: () => void | Promise<void> }) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [kind, setKind] = useState<"interval" | "daily">("interval");
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [atHHMM, setAtHHMM] = useState("09:00");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.schedules();
      setRows(r.schedules.filter((s) => s.workflowId === workflowId));
    } catch {
      /* agent restarting */
    }
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const spec = kind === "interval" ? { kind: "interval", everyMinutes } : { kind: "daily", atHHMM };
      await api.createSchedule(workflowId, spec, {});
      await load();
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (row: ScheduleRow) => {
    setBusy(true);
    try {
      await api.setScheduleEnabled(row.id, !row.enabled);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.deleteSchedule(id);
      await load();
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12, borderTop: "1px dashed var(--line)", paddingTop: 10 }}>
      <strong>التشغيل المجدول</strong>
      <p className="sub" style={{ margin: "4px 0 8px" }}>
        بيشتغل بس والتطبيق مفتوح على الجهاز — الموافقات والتحققات بتنطبق زي أي تشغيل.
      </p>
      {err && <div className="notice bad">{err}</div>}
      {rows.map((s) => (
        <div className="row" key={s.id} style={{ marginBottom: 6 }}>
          <span className="chip">{SPEC_AR(s.spec)}</span>
          <span className="sub" style={{ margin: 0 }}>
            {s.enabled ? `الجاري: ${new Date(s.nextRunAt).toLocaleString("ar-EG")}` : "موقوف"}
          </span>
          {s.lastRunState && (
            <span className={`chip ${s.lastRunState === "completed" ? "" : "chip"}`} style={{ color: s.lastRunState === "completed" ? "var(--ok)" : s.lastRunState === "failed" ? "var(--bad)" : "var(--muted)" }}>
              {s.lastRunState === "completed" ? "آخر تشغيل: ✓" : s.lastRunState === "failed" ? "آخر تشغيل: ✗" : ""}
              {s.lastRunError ? ` ${s.lastRunError.slice(0, 40)}` : ""}
            </span>
          )}
          <button className="ghost small" onClick={() => void toggle(s)} disabled={busy}>
            {s.enabled ? "إيقاف الجدولة" : "تشغيل الجدولة"}
          </button>
          <button className="ghost small" onClick={() => void remove(s.id)} disabled={busy}>
            حذف
          </button>
        </div>
      ))}
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as "interval" | "daily")} style={{ maxWidth: 170 }}>
          <option value="interval">كل فترة محددة</option>
          <option value="daily">يوميًا في وقت</option>
        </select>
        {kind === "interval" ? (
          <label className="f" style={{ margin: 0, maxWidth: 130 }}>
            <input type="number" min={1} max={525600} value={everyMinutes} onChange={(e) => setEveryMinutes(Number(e.target.value))} />
          </label>
        ) : (
          <input type="time" value={atHHMM} onChange={(e) => setAtHHMM(e.target.value)} style={{ maxWidth: 130 }} />
        )}
        <button className="primary small" onClick={() => void create()} disabled={busy}>
          + فعّل الجدولة
        </button>
      </div>
    </div>
  );
}
