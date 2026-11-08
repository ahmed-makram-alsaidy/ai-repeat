/**
 * AI Repeat — Teach Mode session (P1, deterministic subset).
 * Opens ONE visible agent-owned browser with a dedicated profile, records
 * explicitly-supported user actions while the session is active, and produces
 * a reviewable workflow draft. Password/OTP/card values are never captured.
 */
import path from "node:path";
import {
  installDomainGuard,
  leasePersistentContext,
  resolveChromiumExecutable,
  startRecording,
  toWorkflowDraft,
  trackBrowserPid,
  untrackBrowserPid,
  type RecorderHandle,
} from "@ai-repeat/workflows";
import { DomainAllowlist } from "@ai-repeat/security";
import type { Settings } from "./config.js";

export interface TeachStatus {
  active: boolean;
  url?: string;
  message: string;
}

export class TeachManager {
  private lease?: Awaited<ReturnType<typeof leasePersistentContext>>;
  private recorder?: RecorderHandle;

  constructor(private readonly settings: Settings) {}

  get active(): boolean {
    return Boolean(this.lease && this.recorder);
  }

  async start(startUrl: string): Promise<TeachStatus> {
    if (this.active) return { active: true, url: this.lease?.context.pages()[0]?.url(), message: "التسجيل شغّال بالفعل" };
    const exe = resolveChromiumExecutable();
    if (!exe) {
      throw new Error("BROWSER_UNAVAILABLE: متصفح Chromium الخاص بالتطبيق مش متسطب (npx playwright install chromium)");
    }
    const allowlist = new DomainAllowlist(this.settings.allowedDomains);
    if (!allowlist.allows(startUrl)) {
      throw new Error(`SECURITY: الرابط خارج النطاقات المسموحة (${this.settings.allowedDomains.join(", ")})`);
    }
    const profileDir = path.join(this.settings.dataDir, "browser-profiles", "teach");
    this.lease = await leasePersistentContext(profileDir, { executablePath: exe, headless: false });
    const teachBrowser = this.lease.context.browser();
    if (teachBrowser) trackBrowserPid(this.settings.dataDir, teachBrowser);
    await installDomainGuard(this.lease.context, allowlist);
    this.recorder = await startRecording(this.lease.context);
    const page = this.lease.context.pages()[0] ?? (await this.lease.context.newPage());
    await page.goto(startUrl, { waitUntil: "load" }).catch(() => {});
    return { active: true, url: page.url(), message: "التسجيل شغّال — نفّذ الخطوات في متصفح المساعد" };
  }

  async stop(): Promise<{ draft: string }> {
    if (!this.lease || !this.recorder) throw new Error("TEACH_NOT_ACTIVE: مفيش جلسة تسجيل شغّالة");
    const events = await this.recorder.stop();
    const stalePid = (this.lease.context.browser() as unknown as { process?: () => { pid?: number } | null } | null)?.process?.()?.pid;
    const url = this.lease.context.pages()[0]?.url();
    await this.lease.release();
    if (stalePid) untrackBrowserPid(this.settings.dataDir, stalePid);
    const lease = this.lease;
    const recorder = this.recorder;
    void lease;
    void recorder;
    this.lease = undefined;
    this.recorder = undefined;

    const { workflow, manualCheckpoints } = toWorkflowDraft(
      {
        id: `taught_${Date.now().toString(36)}`,
        name: "مهمة مسجلة (راجعها قبل التشغيل)",
        allowedDomains: this.settings.allowedDomains,
      },
      events,
    );
    const draft = {
      ...workflow,
      _meta: {
        note: "مسودة أولية للمراجعة — عدّل الخطوات وأسماء المتغيرات قبل الحفظ.",
        manualCheckpoints,
        unsupportedHint: "لو الخطوة متسجلتش، ممكن تكون من إجراءات مش مدعومة لسه.",
      },
    };
    return { draft: JSON.stringify(draft, null, 2) };
  }
}
