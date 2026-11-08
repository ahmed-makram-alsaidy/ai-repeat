import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Version history for one skill (FR-03): every save is kept; restoring a
 * previous version creates a NEW version (never destructive).
 */
export default function VersionsSection({ workflowId, onChanged }: { workflowId: string; onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Array<{ version: number; createdAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!open) return;
    try {
      const r = await api.workflowVersions(workflowId);
      setVersions(r.versions);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [open, workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (version: number) => {
    setBusy(true);
    setErr(null);
    try {
      await api.restoreWorkflowVersion(workflowId, version);
      setMsg(`اترجعت النسخة ${version} كنسخة جديدة ✓`);
      await load();
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10, borderTop: "1px dashed var(--line)", paddingTop: 8 }}>
      <button className="ghost small" onClick={() => setOpen(!open)}>
        {open ? "إخفاء النسخ السابقة" : "النسخ السابقة"}
      </button>
      {msg && <div className="notice ok" style={{ marginTop: 8 }}>{msg}</div>}
      {err && <div className="notice bad" style={{ marginTop: 8 }}>{err}</div>}
      {open && (
        <div style={{ marginTop: 8 }}>
          {versions.map((v) => (
            <div className="row" key={v.version} style={{ marginBottom: 4 }}>
              <span className="chip">نسخة {v.version}</span>
              <span className="sub" style={{ margin: 0 }}>{new Date(v.createdAt).toLocaleString("ar-EG")}</span>
              <button className="ghost small" onClick={() => void restore(v.version)} disabled={busy}>
                استرجع
              </button>
            </div>
          ))}
          {versions.length === 0 && <p className="sub" style={{ margin: 0 }}>مفيش نسخ محفوظة بعد.</p>}
        </div>
      )}
    </div>
  );
}
