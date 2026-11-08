import { useState } from "react";
import { useApp } from "../App.js";
import { api } from "../api.js";
import WorkflowEditor from "../components/WorkflowEditor.js";
import { parseDraft, type DraftWorkflow } from "../lib/step-editor.js";
import type { Lang } from "../lib/i18n.js";

export default function Teach({ lang }: { lang: Lang }) {
  const { refresh } = useApp();
  const [status, setStatus] = useState<{ active: boolean; url?: string; message: string } | null>(null);
  const [editingWf, setEditingWf] = useState<DraftWorkflow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.teachStart("http://127.0.0.1:4177/");
      setStatus(r.status);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.teachStop();
      const parsed = parseDraft(r.draft);
      if (!parsed.ok) {
        setErr(parsed.error);
      } else {
        setStatus(null);
        setEditingWf(parsed.wf);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>علّمني مهمة</h1>
      <p className="sub">هنستخدم متصفح المساعد، مش الماوس بتاعك.</p>

      <div className="notice">
        مش بنسجل كلمات السر أو رموز التحقق. هنسألك عنها وقت الحاجة من غير ما نحفظها. حاليًا التسجيل بيدعم: فتح صفحات،
        ضغط أزرار، كتابة في حقول عادية، واختيار قوائم — وبعدها تعدّل الخطوات هنا قبل الحفظ.
      </div>

      {err && <div className="notice bad">{err}</div>}
      {saved && <div className="notice ok">اتحفظت المهارة <code>{saved}</code> ✓ — موجودة دلوقتي في «مهاراتي».</div>}

      {status?.active ? (
        <div className="card">
          <p>
            <span className="rec-dot" /> التسجيل شغّال — نفّذ الخطوات في متصفح المساعد اللي فتح. لما تخلص اضغط «وقف
            التسجيل».
          </p>
          <p className="mono">{status.url}</p>
          <button className="danger" onClick={stop} disabled={busy}>
            وقف التسجيل
          </button>
        </div>
      ) : (
        !editingWf && (
          <div className="card">
            <ol style={{ lineHeight: 1.9, color: "var(--muted)" }}>
              <li>اختار الموقع اللي هنشتغل عليه (حاليًا: سيرفر التجربة المحلي).</li>
              <li>ابدأ التسجيل — هيتفتح متصفح المساعد بنافذة واضحة.</li>
              <li>نفّذ الخطوات مرة واحدة، وبعدها وقف التسجيل وراجع الخطوات هنا.</li>
            </ol>
            <button className="primary" onClick={start} disabled={busy}>
              ابدأ التسجيل
            </button>
          </div>
        )
      )}

      {editingWf && (
        <WorkflowEditor
          initialWf={editingWf}
          onSaved={(id) => {
            setEditingWf(null);
            setSaved(id);
            void refresh();
          }}
          onCancel={() => setEditingWf(null)}
        />
      )}
    </div>
  );
}
