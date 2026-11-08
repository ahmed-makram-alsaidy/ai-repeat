import { useEffect, useRef, useState } from "react";
import { useApp } from "../App.js";
import { api } from "../api.js";
import WorkflowEditor from "../components/WorkflowEditor.js";
import { parseDraft, type DraftWorkflow } from "../lib/step-editor.js";
import { createRecognizer, speechRecognitionAvailable, voiceFlags, type SpeechRecognitionLike } from "../lib/voice.js";
import { t, type Lang } from "../lib/i18n.js";

export default function Assistant({ lang }: { lang: Lang }) {
  const { boot, openTasksPage, refresh } = useApp();
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftWf, setDraftWf] = useState<DraftWorkflow | null>(null);
  const [sttEngine, setSttEngine] = useState<string>("");
  const [result, setResult] = useState<{
    plan?: { summary: string; steps: string[]; suggestedWorkflowId: string | null; risk: string } | null;
    offlineFallback?: boolean;
    note?: string;
    error?: string;
  } | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  // Unmount cleanup: never leave a recognizer running (no background listening).
  useEffect(() => () => recRef.current?.abort(), []);

  // Show the active STT engine so the user knows what's listening.
  useEffect(() => {
    void api.getSttConfig().then((c) => setSttEngine(c.engine)).catch(() => {});
  }, []);

  const toggleRecording = () => {
    setVoiceErr(null);
    if (recording) {
      recRef.current?.stop();
      return;
    }
    const rec = createRecognizer({
      lang: "ar-EG",
      onFinal: (t) => setText((cur) => (cur ? `${cur} ${t}` : t)),
      onInterim: (t) => setInterim(t),
      onEnd: () => {
        setRecording(false);
        setInterim("");
        recRef.current = null;
      },
      onError: (code) => setVoiceErr(`التعرف على الصوت: ${code}`),
    });
    if (!rec) {
      setVoiceErr("محرك التعرف على الصوت مش متاح في النافذة دي.");
      return;
    }
    recRef.current = rec;
    try {
      rec.start();
      setRecording(true);
    } catch (e) {
      setVoiceErr(e instanceof Error ? e.message : String(e));
      recRef.current = null;
    }
  };

  const submit = async () => {
    setBusy(true);
    setRunErr(null);
    try {
      const r = await api.plan(text);
      setResult(r);
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const generateDraft = async () => {
    setDraftBusy(true);
    setRunErr(null);
    try {
      const res = await fetch("/api/workflows/draft-from-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json()) as { draft?: string; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? res.statusText);
      const parsed = parseDraft(body.draft!);
      if (!parsed.ok) throw new Error(parsed.error);
      setDraftWf(parsed.wf);
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftBusy(false);
    }
  };

  const runSuggested = async (workflowId: string) => {
    setRunErr(null);
    try {
      const { task } = await api.runWorkflow(workflowId, {});
      await refresh();
      openTasksPage(task.id);
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <h1>{t(lang, "assistant.title")}</h1>
      <p className="sub">قولّي عايزني أعمل إيه… زي: افتح لوحة المنتجات وطلّعلي الأصناف اللي ناقصة صور.</p>

      <div className="card">
        <label className="f">
          <span>{t(lang, "assistant.describe")}</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t(lang, "assistant.placeholder")} />
        </label>
        <div className="row">
          <button className="primary" onClick={submit} disabled={busy || text.trim().length < 3}>
            {t(lang, "assistant.propose")}
          </button>
          {voiceFlags.sttEnabled() && speechRecognitionAvailable() && (
            <button className={recording ? "danger" : "ghost"} onClick={toggleRecording}>
              {recording ? "وقف التسجيل" : "اضغط وتكلم"}
            </button>
          )}
          {recording && interim && <span className="sub" style={{ margin: 0 }}>…{interim}</span>}
          <span className="chip">النطاق المسموح: {(boot?.settings.allowedDomains ?? []).join("، ")}</span>
          <span className="chip">الخطوات المتوقعة: 3–5</span>
          <span className="chip">المخاطر: قراءة/كتابة محلية</span>
          {sttEngine && (
            <span className="chip">
              🎙 {sttEngine === "whisper-local" ? "whisper محلي" : sttEngine === "web-speech" ? "مدمج" : "بدون صوت"}
            </span>
          )}
        </div>
        {voiceErr && <div className="notice bad" style={{ marginTop: 10 }}>{voiceErr}</div>}
        {runErr && <div className="notice bad" style={{ marginTop: 10 }}>{runErr}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="ghost" onClick={() => void generateDraft()} disabled={draftBusy || text.trim().length < 3} title="النموذج بيكتب مسودة، والفحص والمراجعة عليك قبل الحفظ">
            {draftBusy ? t(lang, "assistant.generating") : t(lang, "assistant.generateDraft")}
          </button>
          <span className="sub" style={{ margin: 0 }}>المسودة بتفتح في المحرر للمراجعة — بتتحفظ بعد مراجعتك وبموافقات التشغيل زي أي مهارة.</span>
        </div>
      </div>

      {draftWf && (
        <WorkflowEditor
          initialWf={draftWf}
          onSaved={(id) => {
            setDraftWf(null);
            setText("");
            void refresh();
            setRunErr(null);
            setVoiceErr(null);
            window.alert(`اتحفظت المهارة ${id} — موجودة في «مهاراتي».`);
          }}
          onCancel={() => setDraftWf(null)}
        />
      )}

      {result && (
        <div className="card">
          {result.offlineFallback && (
            <div className="notice">
              {result.note} <br />
              <span className="mono">[{result.error?.slice(0, 160)}]</span>
            </div>
          )}
          {result.plan ? (
            <>
              <h2 style={{ marginTop: 0 }}>الخطة المقترحة — راجعها قبل التنفيذ</h2>
              <p>{result.plan.summary}</p>
              <ol>
                {result.plan.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <div className="row">
                <span className="chip">التصنيف: {result.plan.risk}</span>
                {result.plan.suggestedWorkflowId && (
                  <button className="primary" onClick={() => runSuggested(result.plan!.suggestedWorkflowId!)}>
                    راجع الخطوات وشغّل المهارة المطابقة
                  </button>
                )}
              </div>
            </>
          ) : (
            !result.offlineFallback && <p className="sub">مفيش خطة رجعت من النموذج.</p>
          )}
        </div>
      )}
    </div>
  );
}
