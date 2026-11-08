import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../App.js";
import { api } from "../api.js";
import WorkflowEditor from "../components/WorkflowEditor.js";
import ScheduleSection from "../components/ScheduleSection.js";
import VersionsSection from "../components/VersionsSection.js";
import { parseDraft, type DraftWorkflow } from "../lib/step-editor.js";
import { t, type Lang } from "../lib/i18n.js";

interface WorkflowRow {
  id: string;
  version: number;
  workflow: {
    name?: string;
    description?: string;
    allowedDomains?: string[];
    inputs?: Array<{ name: string; type: string; required: boolean; description?: string }>;
    steps?: Array<{ id: string; action: string; risk: string; summary?: string }>;
  };
  updatedAt: string;
}

export default function Skills({ lang }: { lang: Lang }) {
  const { openTasksPage, refresh } = useApp();
  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftWorkflow | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const filtered = rows.filter((w) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = `${w.workflow.name ?? ""} ${w.id} ${w.workflow.description ?? ""}`.toLowerCase();
    return hay.includes(q);
  });

  const load = useCallback(async () => {
    try {
      const r = await api.workflows();
      setRows(r.workflows as WorkflowRow[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      const { task } = await api.runWorkflow(id, inputs);
      setInputs({});
      await refresh();
      openTasksPage(task.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = async (id: string) => {
    setErr(null);
    try {
      const r = await api.workflows();
      const row = (r.workflows as WorkflowRow[]).find((w) => w.id === id);
      if (!row) throw new Error("المهارة مش موجودة");
      const parsed = parseDraft(JSON.stringify(row.workflow));
      if (!parsed.ok) {
        setErr(`المهارة دي مش صالحة للتعديل: ${parsed.error}`);
        return;
      }
      setEditing({ ...parsed.wf, id: row.id });
      setOpen(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const importFile = async (file: File) => {
    setErr(null);
    setNotice(null);
    try {
      const text = await file.text();
      const wf = JSON.parse(text) as unknown;
      const res = await api.importWorkflow(wf);
      setNotice(
        res.renamed
          ? `اتستوردت باسم جديد ${res.id} — كان فيه مهارة بنفس المعرف فمستبدلناش حاجة عندك.`
          : `اتستوردت المهارة ${res.id} ✓`,
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (editing) {
    return (
      <div>
        <h1>تعديل مهارة</h1>
        <p className="sub">
          <code>{editing.id}</code> — الحفظ بيعمل نسخة جديدة من نفس المهارة (version++).
        </p>
        <WorkflowEditor
          initialWf={editing}
          onSaved={async (id) => {
            setEditing(null);
            setNotice(`اتحفظت نسخة جديدة من ${id} ✓`);
            await load();
            await refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div>
      <h1>{t(lang, "skills.title")}</h1>
      <p className="sub">{t(lang, "skills.subtitle")}</p>
      {err && <div className="notice bad">{err}</div>}
      {notice && <div className="notice ok">{notice}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
        <button className="ghost" onClick={() => fileInput.current?.click()}>
          استيراد مهارة (ملف JSON)
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ابحث بالاسم أو الوصف…"
          style={{ maxWidth: 260 }}
        />
      </div>

      {filtered.map((w) => {
        const isOpen = open === w.id;
        return (
          <div className="card" key={w.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{w.workflow.name ?? w.id}</strong>
                <div className="sub" style={{ margin: "4px 0 0" }}>
                  <code>{w.id}</code> — نسخة {w.version}
                </div>
              </div>
              <div className="row">
                <button className="ghost small" onClick={() => setOpen(isOpen ? null : w.id)}>
                  {isOpen ? t(lang, "skills.hideDetails") : t(lang, "skills.details")}
                </button>
                <button className="ghost small" onClick={() => void startEdit(w.id)}>
                  {t(lang, "skills.edit")}
                </button>
                <button
                  className="ghost small"
                  onClick={async () => {
                    try {
                      await api.duplicateSkill(w.id);
                      await load();
                    } catch (ex) {
                      setErr(ex instanceof Error ? ex.message : String(ex));
                    }
                  }}
                >
                  استنساخ
                </button>
                <a href={api.exportWorkflowUrl(w.id)} download={`${w.id}.json`}>
                  <button className="ghost small">{t(lang, "skills.export")}</button>
                </a>
                <button className="primary small" onClick={() => run(w.id)} disabled={busy}>
                  {t(lang, "skills.run")}
                </button>
              </div>
            </div>

            {isOpen && (
              <div style={{ marginTop: 12 }}>
                {w.workflow.description && <p>{w.workflow.description}</p>}
                <p className="sub">النطاقات المسموحة: {(w.workflow.allowedDomains ?? []).join("، ")}</p>
                {(w.workflow.steps ?? []).length > 0 && (
                  <ol style={{ color: "var(--muted)", lineHeight: 1.8 }}>
                    {(w.workflow.steps ?? []).map((s) => (
                      <li key={s.id}>
                        {s.summary ?? s.action}{" "}
                        <span className="chip">{s.risk === "read" ? "قراءة" : s.risk === "local_write" ? "كتابة محلية" : s.risk === "external_write" ? "خارجي — بموافقة" : s.risk}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {(w.workflow.inputs ?? []).length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong>مدخلات التشغيل</strong>
                    {(w.workflow.inputs ?? []).map((inp) => (
                      <label className="f" key={inp.name}>
                        <span>
                          {inp.description ?? inp.name} {inp.required ? "*" : ""} ({inp.name}: {inp.type})
                        </span>
                        <input
                          value={inputs[inp.name] ?? ""}
                          onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                          placeholder={inp.name}
                        />
                      </label>
                    ))}
                  </div>
                )}
                <ScheduleSection workflowId={w.id} onChanged={load} />
                <VersionsSection workflowId={w.id} onChanged={load} />
              </div>
            )}
          </div>
        );
      })}

      {filtered.length === 0 && (
        <p className="sub">{rows.length === 0 ? "مفيش مهارات محفوظة — ابدأ من «علّمني مهمة» أو استورد ملف." : "مفيش نتائج للبحث ده."}</p>
      )}
    </div>
  );
}
