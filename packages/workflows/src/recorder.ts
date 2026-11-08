/**
 * AI Repeat — Teach Mode recorder (P1, deterministic subset).
 * Records user actions performed in the agent-owned visible browser only
 * while a recording session is explicitly active. Password/OTP/card values
 * are NEVER captured — sensitive fields become manual checkpoints.
 */
import type { BrowserContext, Page } from "playwright-core";

export interface RecordedAction {
  kind: "navigate" | "click" | "fill" | "select";
  at: string;
  url?: string;
  /** Suggested locator in Workflow locator shape (may be uncertain). */
  locator?: { strategy: "role" | "label" | "testid" | "text" | "css"; value: string; name?: string; uncertain?: boolean };
  value?: string;
  /** Set when the user typed into a sensitive field — value intentionally never captured. */
  sensitive?: true;
  fieldLabel?: string;
}

export interface RecorderHandle {
  stop: () => Promise<RecordedAction[]>;
  events: RecordedAction[];
}

const SUBMIT_HINTS = /(إرسال|ارسال|حفظ|تسجيل|submit|send|save|checkout|ادفع|شراء|حذف|delete|pay)/i;

export async function startRecording(context: BrowserContext): Promise<RecorderHandle> {
  const events: RecordedAction[] = [];
  const stoppers: Array<() => void> = [];

  // Navigation capture via Playwright events; DOM actions via the injected
  // listener below (reliable across pages — context-wide init script).
  for (const page of context.pages()) {
    const onNav = (frame: import("playwright-core").Frame) => {
      if (frame !== page.mainFrame()) return;
      events.push({ kind: "navigate", at: new Date().toISOString(), url: frame.url() });
    };
    page.on("framenavigated", onNav);
    stoppers.push(() => page.off("framenavigated", onNav));
  }
  await context.exposeBinding("__aiRepeatRecord", (_source, payload: unknown) => {
    const p = payload as { kind: string; url?: string; locator?: RecordedAction["locator"]; value?: string; sensitive?: boolean; fieldLabel?: string };
    if (p.kind === "click") {
      events.push({ kind: "click", at: new Date().toISOString(), url: p.url, locator: p.locator });
    } else if (p.kind === "fill") {
      events.push({
        kind: "fill",
        at: new Date().toISOString(),
        url: p.url,
        locator: p.locator,
        value: p.sensitive ? undefined : p.value,
        sensitive: p.sensitive ? true : undefined,
        fieldLabel: p.fieldLabel,
      });
    } else if (p.kind === "select") {
      events.push({ kind: "select", at: new Date().toISOString(), url: p.url, locator: p.locator, value: p.value });
    }
  });
  await context.addInitScript(`
    (() => {
      const send = (payload) => { try { window.__aiRepeatRecord(payload); } catch {} };
      const snapshot = (el) => {
        if (!el || !el.tagName) return undefined;
        const tag = el.tagName.toLowerCase();
        const testid = el.getAttribute('data-testid');
        const id = el.id;
        const name = el.name;
        const role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : undefined);
        const accName = el.getAttribute('aria-label') || ((tag === 'button' || tag === 'a') ? (el.textContent || '').trim().slice(0, 80) : undefined);
        const labelFor = id && document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent?.trim().slice(0, 80);
        if (testid) return { strategy: 'testid', value: testid };
        if (role && accName) return { strategy: 'role', value: role, name: accName };
        if (labelFor) return { strategy: 'label', value: labelFor };
        if (id) return { strategy: 'css', value: '#' + CSS.escape(id), uncertain: true };
        if (name) return { strategy: 'css', value: '[name="' + name + '"]', uncertain: true };
        const text = (el.textContent || '').trim().slice(0, 40);
        if (text) return { strategy: 'text', value: text, uncertain: true };
        return { strategy: 'css', value: tag, uncertain: true };
      };
      const sensitive = (el) => {
        const t = (el.type || '').toLowerCase();
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        const nm = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
        if (t === 'password' || t === 'hidden') return true;
        if (ac.startsWith('cc-') || ac === 'one-time-code' || ac.includes('password')) return true;
        if (/(otp|one[-_]?time|passcode|password|cvv|cvc|card-?number)/.test(nm)) return true;
        return false;
      };
      const labelOf = (el) => {
        const id = el.id;
        const l = id && document.querySelector('label[for="' + CSS.escape(id) + '"]');
        return l ? l.textContent.trim().slice(0, 80) : el.getAttribute('aria-label') || el.name || undefined;
      };
      document.addEventListener('click', (ev) => {
        const el = ev.target instanceof Element ? ev.target.closest('button, a, [role=button], input[type=submit]') : null;
        if (!el) return;
        send({ kind: 'click', url: location.href, locator: snapshot(el) });
      }, true);
      document.addEventListener('change', (ev) => {
        const el = ev.target;
        if (!el || !el.tagName || el.tagName.toLowerCase() !== 'select') return;
        send({ kind: 'select', url: location.href, locator: snapshot(el), value: el.value });
      }, true);
      document.addEventListener('focusout', (ev) => {
        const el = ev.target;
        if (!el || !el.tagName) return;
        const tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') return;
        if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'submit' || el.type === 'button') return;
        // Send immediately: focusout fires once per blur, and a shared debounce
        // would drop rapid consecutive fields (test G3 fills three fields in a row).
        if (sensitive(el)) {
          send({ kind: 'fill', url: location.href, locator: snapshot(el), sensitive: true, fieldLabel: labelOf(el) });
          return;
        }
        send({ kind: 'fill', url: location.href, locator: snapshot(el), value: el.value, fieldLabel: labelOf(el) });
      }, true);
    })();
  `);

  const onPage = (page: Page) => {
    const onNav = (frame: import("playwright-core").Frame) => {
      if (frame !== page.mainFrame()) return;
      events.push({ kind: "navigate", at: new Date().toISOString(), url: frame.url() });
    };
    page.on("framenavigated", onNav);
    stoppers.push(() => page.off("framenavigated", onNav));
  };
  context.on("page", onPage);

  return {
    events,
    stop: async () => {
      context.off("page", onPage);
      for (const s of stoppers) s();
      return events;
    },
  };
}

/** Converts raw recorded actions into a reviewable draft workflow (schema-valid after user review). */
export function toWorkflowDraft(
  opts: { id: string; name: string; allowedDomains: string[] },
  events: RecordedAction[],
): {
  workflow: Record<string, unknown>;
  variables: Array<{ name: string; fieldLabel?: string; suggestedValue?: string }>;
  manualCheckpoints: Array<{ after: string; fieldLabel?: string }>;
} {
  const steps: Array<Record<string, unknown>> = [];
  const variables: Array<{ name: string; fieldLabel?: string; suggestedValue?: string }> = [];
  const manualCheckpoints: Array<{ after: string; fieldLabel?: string }> = [];
  let varIdx = 0;
  let lastWasSubmit = false;

  events
    .filter((e) => e.kind === "navigate" || e.locator)
    .forEach((e, i) => {
      const id = `step_${i + 1}`;
      if (e.kind === "navigate" && e.url) {
        // A navigation immediately after a submit click is the submission's own
        // response page (an effect, not a step) — replaying the click already lands there.
        if (lastWasSubmit) {
          lastWasSubmit = false;
          return;
        }
        // The initial navigation is kept: a replay must open the page first.
        steps.push({ id, action: "navigate", url: e.url, risk: "read", summary: `فتح ${e.url}` });
        return;
      }
      if (e.kind === "click" && e.locator) {
        const submit = e.fieldLabel === "__submit_hint__" || SUBMIT_HINTS.test(e.locator.name ?? e.locator.value);
        lastWasSubmit = submit;
        steps.push({
          id,
          action: "click",
          locator: e.locator,
          risk: submit ? "external_write" : "read",
          requiresApproval: submit,
          summary: submit ? "إرسال (يتطلب موافقة)" : `ضغط على ${e.locator.name ?? e.locator.value}`,
        });
        return;
      }
      if (e.kind === "fill" && e.locator) {
        if (e.sensitive) {
          manualCheckpoints.push({ after: id, fieldLabel: e.fieldLabel });
          steps.push({
            id,
            action: "request_approval",
            risk: "external_write",
            requiresApproval: true,
            summary: `نقطة تحقق يدوية: إدخال بيانات حساسة (${e.fieldLabel ?? "حقل"}) — لن تُحفظ ولا تُسجّل`,
          });
          return;
        }
        const varName = `var${++varIdx}`;
        variables.push({ name: varName, fieldLabel: e.fieldLabel, suggestedValue: e.value });
        steps.push({
          id,
          action: "fill",
          locator: e.locator,
          value: `{{${varName}}}`,
          risk: "read",
          summary: `كتابة في ${e.fieldLabel ?? e.locator.name ?? e.locator.value}`,
        });
        return;
      }
      if (e.kind === "select" && e.locator) {
        steps.push({ id, action: "select", locator: e.locator, value: e.value ?? "", risk: "read" });
      }
    });

  const workflow = {
    schemaVersion: "0.1",
    id: opts.id,
    name: opts.name,
    allowedDomains: opts.allowedDomains,
    inputs: variables.map((v, i) => ({
      name: v.name,
      type: "string",
      required: true,
      description: v.fieldLabel ?? `قيمة الخطوة ${i + 1}`,
    })),
    steps,
    // Empty by design: the reviewer adds real postconditions in the editor
    // (a bogus placeholder verification would fail every run).
    verification: [] as Array<{ kind: string; target?: string }>,
    policy: { autoApproveRead: true, autoApproveLocalWrite: true },
  };
  return { workflow, variables, manualCheckpoints };
}
