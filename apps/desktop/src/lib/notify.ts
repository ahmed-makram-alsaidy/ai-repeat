/**
 * AI Repeat — optional desktop notifications (permission-gated, off by default).
 * Uses the standard Web Notification API — works in the Tauri WebView2 shell
 * and in the browser. The user opts in from الإعدادات; nothing fires before that.
 */

export const notifyFlags = {
  enabled: (): boolean => localStorage.getItem("notify.tasks") === "1",
  setEnabled: (on: boolean): void => localStorage.setItem("notify.tasks", on ? "1" : "0"),
};

export async function notificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Enables notifications: asks the OS/browser for permission first. */
export async function enableTaskNotifications(): Promise<{ ok: boolean; permission: string }> {
  if (typeof Notification === "undefined") return { ok: false, permission: "unsupported" };
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  const ok = perm === "granted";
  notifyFlags.setEnabled(ok);
  return { ok, permission: perm };
}

export function disableTaskNotifications(): void {
  notifyFlags.setEnabled(false);
}

export function notifyTask(event: string, workflowName: string, taskId: string): void {
  if (!notifyFlags.enabled() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const title =
    event === "task.completed" ? "✓ مهمة اكتملت" : event === "task.failed" ? "✗ مهمة فشلت" : "المهمة اتلغت";
  try {
    const n = new Notification(`${title} — ${workflowName}`, {
      body: "افتح AI Repeat للتفاصيل والتقرير.",
      tag: taskId, // collapse duplicates for the same task
    });
    n.onclick = () => window.focus();
    setTimeout(() => n.close(), 8000);
  } catch {
    /* notification failures must never break the app */
  }
}
