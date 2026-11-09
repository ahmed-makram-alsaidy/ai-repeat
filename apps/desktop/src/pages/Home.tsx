import { useEffect, useState } from "react";
import { STATE_AR, useApp } from "../App.js";
import { api } from "../api.js";
import { SPEC_AR } from "../components/ScheduleSection.js";
import { t, type Lang } from "../lib/i18n.js";

export default function Home({ lang }: { lang: Lang }) {
  const { boot, openTasksPage } = useApp();
  const live = (boot?.tasks ?? []).filter((t) => !["completed", "failed", "cancelled"].includes(t.state));
  const completed = (boot?.tasks ?? []).filter((t) => t.state === "completed").length;
  const attention = (boot?.tasks ?? []).filter((t) => t.state === "awaiting_approval" || t.state === "failed").length;
  const [upcoming, setUpcoming] = useState<Array<{ id: string; workflowId: string; spec: { kind: string; everyMinutes?: number; atHHMM?: string }; enabled: boolean; nextRunAt: string }>>([]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.schedules();
        setUpcoming(r.schedules.filter((s) => s.enabled).slice(0, 5));
      } catch {
        /* agent restarting */
      }
    })();
  }, [boot?.tasks?.length]);

  return (
    <div>
      <h1>{t(lang, "home.title")}</h1>
      <p className="sub">{t(lang, "home.tagline")}</p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t(lang, "home.start")}</h2>
        <ol style={{ lineHeight: 2.1, margin: 0 }}>
          <li>
            {boot?.browserAvailable ? "✓" : "☐"} {t(lang, "home.step1")}{" "}
            {boot?.browserAvailable ? t(lang, "home.step1.ready") : t(lang, "home.step1.missing")}
          </li>
          <li>
            {boot?.settings?.model?.hasApiKey ? "✓" : "☐"} {t(lang, "home.step2")}{" "}
            {boot?.settings?.model?.hasApiKey ? t(lang, "home.step2.set") : t(lang, "home.step2.missing")}{" "}
            <span className="sub" style={{ margin: 0 }}>{t(lang, "home.step2.optional")}</span>
          </li>
          <li>
            {(boot?.tasks?.length ?? 0) > 0 ? "✓" : "☐"} {t(lang, "home.step3")}{" "}
            {(boot?.tasks?.length ?? 0) > 0 ? t(lang, "home.step3.done") : t(lang, "home.step3.todo")}
          </li>
        </ol>
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <a href="#teach">
          <button className="primary">{t(lang, "home.teachNew")}</button>
        </a>
        <a href="#skills">
          <button className="ghost">{t(lang, "home.runSaved")}</button>
        </a>
      </div>

      {!boot?.browserAvailable && (
        <div className="notice">
          متصفح Chromium الخاص بالتطبيق مش متسطب. شغّل مرة واحدة فقط: <code>npx playwright install chromium</code>
        </div>
      )}
      {!boot?.settings?.model?.hasApiKey && (
        <div className="notice">{t(lang, "home.noApiKey")}</div>
      )}

      <div className="metrics">
        <div className="metric">
          <b>{completed}</b>
          <span>{t(lang, "home.kpi.completed")}</span>
        </div>
        <div className="metric">
          <b>{attention}</b>
          <span>{t(lang, "home.kpi.attention")}</span>
        </div>
        <div className="metric">
          <b>{boot?.workflows?.length ?? 0}</b>
          <span>{t(lang, "home.kpi.skills")}</span>
        </div>
        {boot?.kpis?.verifiedSuccessRate != null && (
          <div className="metric">
            <b>{Math.round(boot.kpis.verifiedSuccessRate * 100)}%</b>
            <span>{t(lang, "home.kpi.verifiedRate")}</span>
          </div>
        )}
        {boot?.kpis?.avgRunSeconds != null && (
          <div className="metric">
            <b>{boot.kpis.avgRunSeconds < 90 ? `${Math.round(boot.kpis.avgRunSeconds)}ث` : `${(boot.kpis.avgRunSeconds / 60).toFixed(1)}د`}</b>
            <span>{t(lang, "home.kpi.avgRun")}</span>
          </div>
        )}
        {boot?.kpis?.tokensPerVerifiedRun != null && (
          <div className="metric">
            <b>{Math.round(boot.kpis.tokensPerVerifiedRun).toLocaleString("ar-EG")}</b>
            <span>{t(lang, "home.kpi.tokensPerRun")}</span>
          </div>
        )}
      </div>

      {upcoming.length > 0 && (
        <>
          <h2>{t(lang, "home.upcoming")}</h2>
          <table className="list" style={{ marginBottom: 18 }}>
            <thead>
              <tr>
                <th>المهارة</th>
                <th>التكرار</th>
                <th>{t(lang, "home.nextRun")}</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((s) => (
                <tr key={s.id}>
                  <td>{(boot?.workflows ?? []).find((w) => w.id === s.workflowId)?.name ?? s.workflowId}</td>
                  <td>{SPEC_AR(s.spec)}</td>
                  <td>{new Date(s.nextRunAt).toLocaleString("ar-EG")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>{t(lang, "home.running")}</h2>
      {live.length === 0 ? (
        <p className="sub">{t(lang, "home.noneRunning")}</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>المهمة</th>
              <th>الحالة</th>
              <th>الخطوات</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {live.map((t) => (
              <tr key={t.id}>
                <td>{t.workflowName}</td>
                <td>
                  <span className={`state ${t.state}`}>{STATE_AR[t.state] ?? t.state}</span>
                </td>
                <td>
                  {t.stepsDone}/{t.stepsTotal || "—"}
                </td>
                <td>
                  <button className="ghost small" onClick={() => openTasksPage(t.id)}>
                    عرض
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
