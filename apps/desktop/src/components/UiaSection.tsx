import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

interface UiaWindow {
  pid: number;
  processName: string;
  title: string;
  hwnd: number;
}
interface UiaControl {
  name: string;
  controlType: string;
  enabled: boolean;
  offscreen: boolean;
}

/**
 * Phase-5 STEP 1 — experimental READ-ONLY UIA inspector.
 * Enumerates windows and dumps first-level properties. This UI can never
 * send input to Windows: no such API exists anywhere in the product.
 */
export default function UiaSection() {
  const [enabled, setEnabled] = useState(false);
  const [windows, setWindows] = useState<UiaWindow[]>([]);
  const [controls, setControls] = useState<{ hwnd: number; list: UiaControl[] } | null>(null);
  const [patterns, setPatterns] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.uiaStatus().then((u) => setEnabled(u.readOnlyInspection)).catch(() => {});
  }, []);

  const listWindows = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.uiaWindows();
      setWindows(r.windows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const inspect = async (hwnd: number) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.uiaInspect(hwnd);
      setControls({ hwnd, list: r.controls });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>أتمتة ويندوز — تجريبي (المرحلة 5، خطوة 1)</h2>
      <div className="notice">
        <strong>قراءة فقط:</strong> عرض النوافذ وعناصرها كقائمة معلومات. <strong>لا يوجد في التطبيق أي كود يبعت نقرات
        أو كتابة لويندوز</strong> — المرحلة دي استكشافية بوضوح ومفصولة عن أتمتة المتصفح.
      </div>
      <label className="f">
        <span>
          <input
            type="checkbox"
            style={{ width: "auto", marginInlineEnd: 8 }}
            checked={enabled}
            onChange={async (e) => {
              try {
                await api.uiaFlag(e.target.checked);
                setEnabled(e.target.checked);
                if (!e.target.checked) setPatterns(false);
                if (e.target.checked) void listWindows();
              } catch (ex) {
                setErr(ex instanceof Error ? ex.message : String(ex));
              }
            }}
          />
          فعّل الفاحص التجريبي (قراءة فقط — بموافقتك)
        </span>
      </label>

      {err && <div className="notice bad">{err}</div>}
      {enabled && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="ghost small" onClick={() => void listWindows()} disabled={busy}>
              حدّث قائمة النوافذ
            </button>
          </div>
          {windows.map((w) => (
            <div className="row" key={w.hwnd} style={{ marginBottom: 4 }}>
              <button className="ghost small" onClick={() => void inspect(w.hwnd)} disabled={busy}>
                افحص
              </button>
              <span className="chip">{w.processName}</span>
              <span style={{ fontSize: 13 }}>{w.title.slice(0, 70)}</span>
            </div>
          ))}
          {controls && (
            <table className="list" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الاسم</th>
                  <th>مفعّل</th>
                  <th>خارج الشاشة</th>
                  {patterns && <th>تنفيذ</th>}
                </tr>
              </thead>
              <tbody>
                {controls.list.map((c, i) => (
                  <tr key={i}>
                    <td>{c.controlType}</td>
                    <td>{c.name.slice(0, 60)}</td>
                    <td>{c.enabled ? "✓" : "—"}</td>
                    <td>{c.offscreen ? "✓" : "—"}</td>
                    {patterns && (
                      <td>
                        {/(button|menuitem|listitem|tabitem|treeitem|hyperlink)/i.test(c.controlType) && (
                          <button
                            className="ghost small"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              setErr(null);
                              try {
                                const r = await api.uiaInvoke(controls.hwnd, i);
                                setErr(null);
                                window.alert(`اتنفذ: ${r.invoked}`);
                              } catch (ex) {
                                setErr(ex instanceof Error ? ex.message : String(ex));
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            نفّذ Invoke
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {controls && (
            <label className="f" style={{ marginTop: 8 }}>
              <span>
                <input
                  type="checkbox"
                  style={{ width: "auto", marginInlineEnd: 8 }}
                  checked={patterns}
                  onChange={async (e) => {
                    try {
                      await api.uiaFlag(true, e.target.checked);
                      setPatterns(e.target.checked);
                    } catch (ex) {
                      setErr(ex instanceof Error ? ex.message : String(ex));
                    }
                  }}
                />
                <strong>تفعيل أنماط التنفيذ (تجريبي)</strong> — يسمح بتنفيذ InvokePattern على العناصر اللي بتدعمه. الأنماط دي
                مش بتحرك الماوس الفيزيائي، بس بتشتغل مع التطبيقات اللي بتدعم UIA في الخلفية.
              </span>
            </label>
          )}
        </>
      )}
    </div>
  );
}
