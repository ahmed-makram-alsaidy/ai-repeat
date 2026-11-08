import { useEffect, useState } from "react";
import { useApp } from "../App.js";
import { api } from "../api.js";
import { speechRecognitionAvailable, ttsAvailable, voiceFlags } from "../lib/voice.js";
import { disableTaskNotifications, enableTaskNotifications, notificationPermission } from "../lib/notify.js";
import UiaSection from "../components/UiaSection.js";
import { useRef } from "react";
import { t, type Lang } from "../lib/i18n.js";

export default function SettingsPage({ lang }: { lang: Lang }) {
  const { boot, refresh, events } = useApp();
  const [key, setKey] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [model, setModel] = useState({ provider: "", baseUrl: "", modelId: "", timeoutMs: 60, maxRetries: 3 });
  const [installState, setInstallState] = useState<{ installing: boolean; percent?: number; done?: boolean; error?: string }>({
    installing: false,
  });
  const [sttOn, setSttOn] = useState(() => voiceFlags.sttEnabled());
  const [sttEngine, setSttEngine] = useState("web-speech");
  const [sttBin, setSttBin] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [ttsOn, setTtsOn] = useState(() => voiceFlags.ttsEnabled());
  const [notifyOn, setNotifyOn] = useState(() => localStorage.getItem("notify.tasks") === "1");
  const [notifyPerm, setNotifyPerm] = useState<string>("default");
  const backupInput = useRef<HTMLInputElement>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [arabicVoices, setArabicVoices] = useState("جاري الفحص…");
  useEffect(() => {
    void notificationPermission().then((p) => setNotifyPerm(p));
    if (!ttsAvailable()) {
      setArabicVoices("0");
      return;
    }
    const count = () => {
      const n = window.speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("ar")).length;
      setArabicVoices(String(n));
    };
    count();
    window.speechSynthesis.onvoiceschanged = count;
  }, []);

  useEffect(() => {
    if (boot) {
      void (async () => {
        try {
          const stt = await api.getSttConfig();
          setSttEngine(stt.engine);
          setSttBin(stt.binPath ?? "");
          setSttModel(stt.modelPath ?? "");
        } catch {
          /* ignore — engine endpoints may be restarting */
        }
      })();
      setModel({
        provider: boot.settings.model.provider,
        baseUrl: boot.settings.model.baseUrl,
        modelId: boot.settings.model.modelId,
        timeoutMs: Math.round(boot.settings.model.timeoutMs / 1000),
        maxRetries: boot.settings.model.maxRetries,
      });
    }
  }, [boot]);

  // Live install progress via SSE.
  useEffect(() => {
    const rel = events.filter((e) => e.taskId === "browser-install");
    const last = rel.at(-1);
    if (!last) return;
    if (last.event === "browser.install.started") setInstallState({ installing: true, percent: 0 });
    if (last.event === "browser.install.progress") {
      setInstallState((s) => ({ installing: true, percent: (last.data?.percent as number | undefined) ?? s.percent }));
    }
    if (last.event === "browser.install.done") {
      setInstallState({ installing: false, done: true, percent: 100 });
      void refresh();
    }
    if (last.event === "browser.install.failed") {
      setInstallState({ installing: false, error: String(last.data?.error ?? "فشل التنزيل") });
    }
  }, [events, refresh]);

  const startInstall = async () => {
    setErr(null);
    try {
      setInstallState({ installing: true, percent: 0 });
      await fetch("/api/browser/install", { method: "POST", headers: { "Content-Type": "application/json" } }).then(async (r) => {
        const j = (await r.json()) as { error?: string };
        if (j.error) throw new Error(j.error);
      });
    } catch (e) {
      setInstallState({ installing: false });
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>{lang === "en" ? "Settings" : "الإعدادات"}</h1>
      <p className="sub">{lang === "en" ? "Model connection, allowed scopes, and safety limits." : "الاتصال بالنموذج، المساحات المسموحة، وحدود الأمان."}</p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{lang === "en" ? "Language / اللغة" : "Language / اللغة"}</h2>
        <div className="row">
          <button className={lang === "ar" ? "primary" : "ghost"} onClick={() => wrap(async () => {
            await api.saveAppSettings({ language: "ar" });
            await refresh();
          })}>
            العربية (RTL)
          </button>
          <button className={lang === "en" ? "primary" : "ghost"} onClick={() => wrap(async () => {
            await api.saveAppSettings({ language: "en" });
            await refresh();
          })}>
            English (LTR)
          </button>
        </div>
      </div>
      {err && <div className="notice bad">{err}</div>}

      {boot && !boot.browserAvailable && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>متصفح التطبيق</h2>
          <div className="notice">
            التطبيق محتاج نسخته الخاصة من Chromium علشان يشتغل (~150MB، تنزيل مرة واحدة). الملف بينزل من CDN بتاع
            Playwright ويتمسطب في مجلد الكاش القياسي على جهازك — من غير ما يمس أي متصفح موجود عندك.
          </div>
          {installState.installing ? (
            <div>
              <p>
                جاري التنزيل… <strong>{installState.percent ?? 0}%</strong>
              </p>
              <div style={{ background: "#eef2f6", borderRadius: 8, height: 10, overflow: "hidden" }}>
                <div style={{ background: "var(--accent)", width: `${installState.percent ?? 0}%`, height: "100%" }} />
              </div>
            </div>
          ) : installState.done ? (
            <div className="notice ok">اتسطب ✓ — تقدر تشغّل المهام دلوقتي.</div>
          ) : (
            <div className="row">
              <button className="primary" onClick={startInstall} disabled={busy}>
                نزّل واتسطب الآن
              </button>
              <span className="sub">بالضغط هنا أنت موافق على التنزيل والتسطيب على جهازك.</span>
            </div>
          )}
          {installState.error && <div className="notice bad">{installState.error}</div>}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t(lang, "settings.model")}</h2>
        <div className="notice">
          لما تستخدم نموذج خارجي، جزء من نص المهمة (مش كلمات السر ولا الكوكيز) ممكن يتبعت لمزود النموذج. المفتاح محفوظ
          في مخزن بيانات اعتماد ويندوز (DPAPI) — مش في قاعدة البيانات ولا في المتصفح.
        </div>
        <div className="grid2">
          <label className="f">
            <span>{t(lang, "settings.provider")}</span>
            <select value={model.provider} onChange={(e) => setModel({ ...model, provider: e.target.value })}>
              <option value="zai">Z.ai</option>
              <option value="openai-compatible">متوافق OpenAI (مخصص)</option>
              <option value="offline-demo">وضع تجريبي بدون اتصال</option>
            </select>
          </label>
          <label className="f">
            <span>{t(lang, "settings.modelId")}</span>
            <input className="mono" value={model.modelId} onChange={(e) => setModel({ ...model, modelId: e.target.value })} />
          </label>
          <label className="f">
            <span>{t(lang, "settings.baseUrl")}</span>
            <input className="mono" value={model.baseUrl} onChange={(e) => setModel({ ...model, baseUrl: e.target.value })} />
          </label>
          <label className="f">
            <span>{t(lang, "settings.timeout")}</span>
            <input
              type="number"
              value={model.timeoutMs}
              onChange={(e) => setModel({ ...model, timeoutMs: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="row">
          <button
            className="ghost"
            disabled={busy}
            onClick={() => wrap(async () => {
              await api.saveModelConfig({
                provider: model.provider,
                baseUrl: model.baseUrl,
                modelId: model.modelId,
                timeoutMs: model.timeoutMs * 1000,
                maxRetries: model.maxRetries,
              });
              await refresh();
            })}
          >
            {t(lang, "settings.saveModel")}
          </button>
        </div>

        <h2>{t(lang, "settings.apiKey")}</h2>
        <p className="sub">
          الحالة: {boot?.settings?.model?.hasApiKey ? t(lang, "settings.keySaved") : t(lang, "settings.noKey")}
        </p>
        <div className="row">
          <input
            className="mono"
            style={{ maxWidth: 420 }}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t(lang, "settings.keyPlaceholder")}
          />
          <button
            className="primary"
            disabled={busy || key.trim().length < 8}
            onClick={() => wrap(async () => {
              await api.setKey(key.trim());
              setKey("");
              await refresh();
            })}
          >
            {t(lang, "settings.saveKey")}
          </button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => wrap(async () => {
              setTestResult("جاري الاختبار…");
              const r = await api.testConnection();
              setTestResult(
                r.ok
                  ? `الاتصال نجح ✓ — الموديل ${r.model} (${r.latencyMs ?? "?"}ms)`
                  : `فشل الاتصال: ${r.error}`,
              );
            })}
          >
            {t(lang, "settings.testConnection")}
          </button>
          {testResult && <span>{testResult}</span>}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t(lang, "settings.voice")}</h2>
        <p className="sub">
          مفيش استماع خلفي أبدًا — التسجيل بيشتغل بس لما تضغط «اضغط وتكلم»، والنطق لملخصات المهام اختياري.
        </p>

        <h3 style={{ marginBottom: 6 }}>{t(lang, "settings.sttEngine")}</h3>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="f" style={{ maxWidth: 200 }}>
            <span>المحرك</span>
            <select value={sttEngine} onChange={(e) => setSttEngine(e.target.value)}>
              <option value="web-speech">{t(lang, "settings.stt.builtin")}</option>
              <option value="whisper-local">{t(lang, "settings.stt.whisper")}</option>
              <option value="none">{t(lang, "settings.stt.none")}</option>
            </select>
          </label>
          {sttEngine === "whisper-local" && (
            <>
              <label className="f" style={{ flex: 1, minWidth: 220 }}>
                <span>{t(lang, "settings.stt.binPath")}</span>
                <input className="mono" value={sttBin} onChange={(e) => setSttBin(e.target.value)} placeholder="…\whisper.cpp\Release\whisper-cli.exe" />
              </label>
              <label className="f" style={{ flex: 1, minWidth: 220 }}>
                <span>{t(lang, "settings.stt.modelPath")}</span>
                <input className="mono" value={sttModel} onChange={(e) => setSttModel(e.target.value)} placeholder="…\models\ggml-base.bin" />
              </label>
            </>
          )}
          <button
            className="ghost"
            disabled={busy}
            onClick={() => wrap(async () => {
              await api.saveSttConfig({ engine: sttEngine, binPath: sttBin || undefined, modelPath: sttModel || undefined, language: "ar" });
              await refresh();
            })}
          >
            {t(lang, "settings.saveStt")}
          </button>
        </div>
        <p className="sub" style={{ marginTop: 4 }}>
          whisper المحلي بيشتغل أوفلاين تمامًا — بتنزّله مرة واحدة من المستودع الرسمي (ggml-base يكفي للبداية، ggml-small أدق للعربي).
        </p>
        <label className="f">
          <span>
            <input
              type="checkbox"
              style={{ width: "auto", marginInlineEnd: 8 }}
              checked={sttOn}
              onChange={(e) => {
                voiceFlags.setSttEnabled(e.target.checked);
                setSttOn(e.target.checked);
              }}
            />
            {t(lang, "settings.sttToggle")}
          </span>
        </label>
        <p className="sub" style={{ margin: "0 0 10px" }}>
          محرك التعرف: {speechRecognitionAvailable() ? "متاح في النافذة دي ✓" : "غير متاح في النافذة دي — الزر مش هيظهر"}
        </p>
        <label className="f">
          <span>
            <input
              type="checkbox"
              style={{ width: "auto", marginInlineEnd: 8 }}
              checked={ttsOn}
              onChange={(e) => {
                voiceFlags.setTtsEnabled(e.target.checked);
                setTtsOn(e.target.checked);
              }}
            />
            {t(lang, "settings.ttsToggle")}
          </span>
        </label>
        <p className="sub" style={{ margin: 0 }}>
          النطق: {ttsAvailable() ? "متاح ✓" : "غير متاح"} — الأصوات العربية المتسطة: {arabicVoices}
        </p>

        <h2>{t(lang, "settings.notifications")}</h2>
        <label className="f">
          <span>
            <input
              type="checkbox"
              style={{ width: "auto", marginInlineEnd: 8 }}
              checked={notifyOn}
              onChange={async (e) => {
                if (e.target.checked) {
                  const r = await enableTaskNotifications();
                  setNotifyOn(r.ok);
                  setNotifyPerm(r.permission);
                  if (!r.ok) setErr(`الإشعارات مش مفعّلة (${r.permission}) — اسمح بيها من إعدادات النظام/المتصفح.`);
                } else {
                  disableTaskNotifications();
                  setNotifyOn(false);
                }
              }}
            />
            {t(lang, "settings.notifyToggle")}
          </span>
        </label>
        <p className="sub" style={{ margin: 0 }}>
          الصلاحية: {notifyPerm} — مفيدة خصوصًا مع التشغيل المجدول.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t(lang, "settings.evidence")}</h2>
        <label className="f">
          <span>
            <input
              type="checkbox"
              style={{ width: "auto", marginInlineEnd: 8 }}
              checked={boot?.settings.saveScreenshots ?? false}
              onChange={(e) => wrap(async () => {
                await api.saveSettings({ saveScreenshots: e.target.checked });
                await refresh();
              })}
            />
            حفظ لقطة شاشة عند فشل خطوة (اختياري — جوه مساحة عمل التطبيق فقط، بتتحذف تلقائيًا بعد مدة الاحتفاظ)
          </span>
        </label>
        <label className="f" style={{ maxWidth: 220 }}>
          <span>{t(lang, "settings.retention")}</span>
          <input
            type="number"
            min={1}
            max={365}
            defaultValue={boot?.settings.retentionDays ?? 14}
            onBlur={(e) => wrap(async () => {
              await api.saveSettings({ retentionDays: Number(e.target.value) });
              await refresh();
            })}
          />
        </label>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t(lang, "settings.security")}</h2>
        <ul style={{ lineHeight: 2, color: "var(--muted)" }}>
          <li>
            مساحة العمل المسموحة للملفات: <code className="mono">{boot?.settings.workspaceRoot}</code>
          </li>
          <li>النطاقات المسموحة: {(boot?.settings.allowedDomains ?? []).join("، ")}</li>
          <li>حد الخطوات لكل مهمة: {boot?.settings.budgets.maxStepsPerRun}</li>
          <li>حد التوكنز لكل مهمة: {boot?.settings.budgets.maxTokensPerRun}</li>
          <li>مدة الاحتفاظ بلقطات الشاشة (اختيارية): {boot?.settings.retentionDays} يوم — لقطات الشاشة مطفأة افتراضيًا</li>
          <li>
            الاستهلاك المُقاس من المزود: {boot?.usage?.requests ?? 0} طلب —{" "}
            {(boot?.usage?.inputTokens ?? 0) + (boot?.usage?.outputTokens ?? 0)} توكن
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t(lang, "settings.backup")}</h2>
        <div className="notice">
          الملف بيحتوي: <strong>المهارات + نسخها + سجل المهام + الجداول</strong>. مش بيحتوي:
          <strong> مفاتيح الـAPI (في مخزن ويندوز) ولا بروفايلات المتصفح</strong>. الجداول المستوردة بتوصل موقوفة
          للأمان، والمهارات المتشابهة الاسم بتنقل باسم جديد من غير ما تكسر حاجة عندك.
        </div>
        <div className="row">
          <a href={api.backupUrl()} download>
            <button className="ghost">{t(lang, "settings.backupDownload")}</button>
          </a>
          <input
            ref={backupInput}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setErr(null);
              setBackupMsg(null);
              try {
                const bundle = JSON.parse(await f.text());
                const r = await api.restoreBackup(bundle);
                setBackupMsg(
                  `اتستوعبت: ${r.workflows} مهارة، ${r.tasks} مهمة مؤرشفة، ${r.schedules} جدولة${r.renamed.length ? ` (أسماء جديدة: ${r.renamed.join("، ")})` : ""} ✓`,
                );
                await refresh();
              } catch (ex) {
                setErr(ex instanceof Error ? ex.message : String(ex));
              }
            }}
          />
          <button className="ghost" onClick={() => backupInput.current?.click()}>
            استعادة من ملف
          </button>
          {backupMsg && <span>{backupMsg}</span>}
        </div>
      </div>

      <UiaSection />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t(lang, "settings.knownLimits")}</h2>
        <ul style={{ lineHeight: 2, color: "var(--muted)" }}>
          <li>التطبيق مش بيتحكم في ماوس/كيبورد ويندوز — التنفيذ في متصفح مستقل فقط.</li>
          <li>المهام شغالة بس والجهاز شغّال — مفيش تنفيذ سحابي في النسخة دي.</li>
          <li>التسجيل الصوتي مش مفعّل في النسخة دي (Feature flag مطفي).</li>
          <li>مش بنتجاوز CAPTCHA أو MFA — لو ظهرت هتطلب منك تدخل بنفسك.</li>
        </ul>
      </div>
    </div>
  );
}
