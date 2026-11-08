import { useMemo, useState } from "react";
import { api } from "../api.js";
import {
  INPUT_NAME_RE,
  missingVariables,
  nextVariableName,
  renameVariable,
  stripRecorderArtifacts,
  type DraftStep,
  type DraftVerification,
  type DraftWorkflow,
} from "../lib/step-editor.js";

const ACTION_AR: Record<string, string> = {
  navigate: "فتح صفحة",
  click: "ضغطة",
  fill: "كتابة",
  select: "اختيار",
  wait_visible: "انتظار عنصر",
  extract_table: "قراءة جدول",
  download: "تنزيل ملف",
  export_csv: "تصدير CSV",
  request_approval: "نقطة موافقة",
};

const RISK_AR: Record<string, string> = {
  read: "قراءة",
  local_write: "كتابة محلية",
  external_write: "خارجي — بموافقة",
  high_impact: "أثر عالي",
};

/**
 * Structured no-code workflow editor (FR-03) — shared by Teach Mode drafts
 * and editing saved skills from مهاراتي.
 */
export default function WorkflowEditor({
  initialWf,
  onSaved,
  onCancel,
}: {
  initialWf: DraftWorkflow;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const [wf, setWf] = useState<DraftWorkflow>(initialWf);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const ghosts = useMemo(() => missingVariables(wf), [wf]);

  const patchStep = (idx: number, patch: Partial<DraftStep>) => {
    setWf((cur) => ({ ...cur, steps: cur.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }));
  };

  const patchVerification = (idx: number, patch: Partial<DraftVerification>) => {
    setWf((cur) => ({ ...cur, verification: cur.verification.map((v, i) => (i === idx ? { ...v, ...patch } : v)) }));
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    setWarnings([]);
    try {
      const name = wf.name?.trim() || "مهمة مسجلة";
      const { wf: clean, warnings: w } = stripRecorderArtifacts({ ...wf, name });
      const ghostNames = missingVariables(clean);
      if (ghostNames.length > 0) {
        setErr(`متغيرات مستخدمة ومش معرّفة: ${ghostNames.join("، ")} — عرّفها من لوحة المتغيرات أو استبدلها بقيم.`);
        setBusy(false);
        return;
      }
      const payload = { ...clean, verification: clean.verification.filter((v) => v.kind) };
      const res = await api.saveWorkflow(payload);
      setWarnings(w);
      onSaved(res.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRename = (from: string, to: string) => {
    const r = renameVariable(wf, from, to);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setErr(null);
    setWf(r.wf);
  };

  const convertToVariable = (idx: number) => {
    const step = wf.steps[idx];
    if (!step || typeof step.value !== "string" || step.value === "") return;
    const name = nextVariableName(wf);
    setWf({
      ...wf,
      inputs: [...wf.inputs, { name, type: "string", required: true, description: `قيمة الخطوة ${step.id}` }],
      steps: wf.steps.map((s, i) => (i === idx ? { ...s, value: `{{${name}}}` } : s)),
    });
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>راجع وعدّل الخطوات</h2>
      {err && <div className="notice bad">{err}</div>}
      {warnings.length > 0 && (
        <div className="notice">
          <strong>ملاحظات من المراجعة:</strong>
          <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      <label className="f">
        <span>اسم المهارة</span>
        <input value={wf.name ?? ""} onChange={(e) => setWf({ ...wf, name: e.target.value })} placeholder="مثال: إنشاء مسودة طلب" />
      </label>

      {/* ------------------------------ variables ------------------------------ */}
      <h2>المتغيرات</h2>
      {wf.inputs.length === 0 && <p className="sub">مفيش متغيرات — القيم ثابتة زي ما اتسجلت.</p>}
      {wf.inputs.map((inp) => (
        <div className="row" key={inp.name} style={{ marginBottom: 8 }}>
          <code>{`{{${inp.name}}}`}</code>
          <span className="sub" style={{ margin: 0 }}>{inp.description ?? ""}</span>
          <input
            style={{ maxWidth: 200 }}
            placeholder="اسم جديد (اختياري)"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const to = (e.target as HTMLInputElement).value.trim();
                if (to) doRename(inp.name, to);
              }
            }}
          />
        </div>
      ))}
      {ghosts.length > 0 && <div className="notice bad">متغيرات مستخدمة ومش معرّفة: {ghosts.join("، ")} — غيّر الاسم أو عرّفها.</div>}

      {/* -------------------------------- steps -------------------------------- */}
      <h2>الخطوات ({wf.steps.length})</h2>
      {wf.steps.map((s, idx) => (
        <div className="step-card" key={`${s.id}-${idx}`} style={{ marginBottom: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <span className="chip">{ACTION_AR[s.action] ?? s.action}</span>
              <span className="chip">{RISK_AR[s.risk] ?? s.risk}</span>
              {s.requiresApproval && <span className="chip" style={{ color: "var(--warn)" }}>محتاج موافقة</span>}
              {s.locator?.uncertain && <span className="chip" style={{ color: "var(--bad)" }}>locator غير مؤكد</span>}
            </div>
            <button className="ghost small" onClick={() => setWf({ ...wf, steps: wf.steps.filter((_, i) => i !== idx) })} title="حذف الخطوة">
              حذف
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            <label className="f">
              <span>الوصف اللي يظهر في السجل</span>
              <input value={s.summary ?? ""} onChange={(e) => patchStep(idx, { summary: e.target.value })} />
            </label>
            {s.locator && (
              <p className="sub" style={{ margin: "4px 0" }}>
                الهدف: <code>{s.locator.strategy}</code> = <code>{s.locator.name ?? s.locator.value}</code>
              </p>
            )}
            {s.url && (
              <p className="sub mono" style={{ margin: "4px 0" }}>
                {s.url}
              </p>
            )}
            {(s.action === "fill" || s.action === "select") && typeof s.value === "string" && (
              <div className="row">
                <input
                  list="variable-names"
                  value={s.value}
                  onChange={(e) => patchStep(idx, { value: e.target.value })}
                  style={{ maxWidth: 300 }}
                  placeholder="قيمة أو {{اسم_متغير}}"
                />
                <button className="ghost small" onClick={() => convertToVariable(idx)}>
                  حوّلها لمتغير
                </button>
                {s.value.startsWith("{{") && !INPUT_NAME_RE.test(s.value.replace(/^\{\{|\}\}$/g, "")) && (
                  <span className="fail">اسم متغير غير صالح</span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      <datalist id="variable-names">
        {wf.inputs.map((i) => (
          <option key={i.name} value={`{{${i.name}}}`} />
        ))}
      </datalist>

      {/* ----------------------------- verification ----------------------------- */}
      <h2>التحققات</h2>
      {wf.verification.map((v, idx) => (
        <div className="step-card" key={idx} style={{ marginBottom: 8 }}>
          <div className="row">
            <select value={v.kind} onChange={(e) => patchVerification(idx, { kind: e.target.value })} style={{ maxWidth: 190 }}>
              <option value="url_matches">الرابط يطابق</option>
              <option value="element_visible">عنصر ظاهر</option>
              <option value="file_exists">ملف موجود</option>
              <option value="table_row_count">عدد صفوف الجدول</option>
              <option value="text_contains">الصفحة/الملف يحتوي نص</option>
            </select>
            {v.kind !== "text_contains" && (
              <input
                value={v.target ?? ""}
                onChange={(e) => patchVerification(idx, { target: e.target.value })}
                placeholder={v.kind === "url_matches" ? "http://…/*" : v.kind === "file_exists" ? "demo-output/x.csv" : "selector"}
                style={{ maxWidth: 320 }}
              />
            )}
            {v.kind === "text_contains" && (
              <input
                value={v.expectedText ?? ""}
                onChange={(e) => patchVerification(idx, { expectedText: e.target.value })}
                placeholder="النص المتوقع"
                style={{ maxWidth: 320 }}
              />
            )}
            {v.kind === "table_row_count" && (
              <input
                type="number"
                min={0}
                value={v.expectedCount ?? 0}
                onChange={(e) => patchVerification(idx, { expectedCount: Number(e.target.value) })}
                style={{ maxWidth: 110 }}
              />
            )}
            <button className="ghost small" onClick={() => setWf({ ...wf, verification: wf.verification.filter((_, i) => i !== idx) })}>
              حذف
            </button>
          </div>
        </div>
      ))}
      <button className="ghost small" onClick={() => setWf({ ...wf, verification: [...wf.verification, { kind: "element_visible", target: "" }] })}>
        + ضيف تحقق
      </button>

      {/* -------------------------------- actions ------------------------------- */}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={save} disabled={busy || ghosts.length > 0 || wf.verification.length === 0} title={wf.verification.length === 0 ? "ضيف تحقق واحد على الأقل" : undefined}>
          احفظ المهارة
        </button>
        {wf.verification.length === 0 && <span className="sub" style={{ margin: 0 }}>ضيف تحقق واحد على الأقل قبل الحفظ.</span>}
        <button className="ghost" onClick={onCancel} disabled={busy}>
          استبعد
        </button>
        <button className="ghost" onClick={() => setAdvanced(!advanced)}>
          {advanced ? "إخفاء JSON" : "متقدم: تعديل JSON"}
        </button>
      </div>

      {advanced && (
        <textarea
          className="mono"
          style={{ minHeight: 240, marginTop: 12 }}
          defaultValue={JSON.stringify(wf, null, 2)}
          onBlur={(e) => {
            try {
              const parsed = JSON.parse(e.target.value) as DraftWorkflow;
              if (parsed.schemaVersion !== "0.1" || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
                setErr("JSON ناقص: schemaVersion 0.1 وخطوة واحدة على الأقل.");
                return;
              }
              setWf({ ...parsed, inputs: parsed.inputs ?? [], verification: parsed.verification ?? [] });
              setErr(null);
            } catch (ex) {
              setErr(`JSON غير صالح: ${ex instanceof Error ? ex.message : String(ex)}`);
            }
          }}
        />
      )}
    </div>
  );
}
