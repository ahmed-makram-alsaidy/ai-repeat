/**
 * AI Repeat — Teach Mode draft editor logic (pure functions, unit-tested).
 * Turns the recorder's draft JSON into a reviewable structure, supports
 * variable renaming, and strips recorder-only artifacts before saving
 * (e.g. `locator.uncertain` is not part of the saved workflow contract).
 */

export const VAR_RE = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/;
export const INPUT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface DraftLocator {
  strategy: "role" | "label" | "testid" | "text" | "css";
  value: string;
  name?: string;
  uncertain?: boolean;
}

export interface DraftStep {
  id: string;
  action: string;
  url?: string;
  locator?: DraftLocator;
  value?: string | number | boolean;
  outputKey?: string;
  path?: string;
  risk: string;
  requiresApproval?: boolean;
  summary?: string;
}

export interface DraftInput {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  secret?: boolean;
}

export interface DraftVerification {
  kind: string;
  target?: string | null;
  expectedText?: string | null;
  expectedCount?: number;
}

export interface DraftWorkflow {
  schemaVersion: "0.1";
  id: string;
  name?: string;
  allowedDomains: string[];
  inputs: DraftInput[];
  steps: DraftStep[];
  verification: DraftVerification[];
  policy?: { autoApproveRead?: boolean; autoApproveLocalWrite?: boolean };
  [key: string]: unknown; // recorder drafts carry extra keys (_meta, …)
}

export type ParseResult = { ok: true; wf: DraftWorkflow } | { ok: false; error: string };

export function parseDraft(json: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `JSON غير صالح: ${e instanceof Error ? e.message : String(e)}` };
  }
  const o = obj as Record<string, unknown>;
  if (!o || typeof o !== "object") return { ok: false, error: "المحتوى مش كائن JSON" };
  if (o.schemaVersion !== "0.1") return { ok: false, error: "schemaVersion لازم يكون 0.1" };
  if (!Array.isArray(o.steps) || o.steps.length === 0) return { ok: false, error: "لازم خطوة واحدة على الأقل" };
  if (!Array.isArray(o.allowedDomains) || o.allowedDomains.length === 0) return { ok: false, error: "لازم نطاق مسموح واحد على الأقل" };
  if (typeof o.id !== "string" || !/^[a-zA-Z0-9_-]{3,100}$/.test(o.id)) return { ok: false, error: "المعرف id لازم يكون 3-100 حرف/رقم/_/-" };
  return {
    ok: true,
    wf: {
      ...(o as unknown as DraftWorkflow),
      inputs: Array.isArray(o.inputs) ? (o.inputs as DraftInput[]) : [],
      verification: Array.isArray(o.verification) ? (o.verification as DraftVerification[]) : [],
    },
  };
}

/** Renames a workflow variable everywhere: inputs + every {{from}} in step values. */
export function renameVariable(wf: DraftWorkflow, from: string, to: string): { wf: DraftWorkflow; error?: string } {
  if (!INPUT_NAME_RE.test(to)) {
    return { wf, error: "اسم المتغير لازم يبدأ بحرف لاتيني وبعدها حروف/أرقام/_" };
  }
  if (to === from) return { wf };
  if (wf.inputs.some((i) => i.name === to)) return { wf, error: `فيه متغير تاني اسمه ${to} بالفعل` };
  const re = new RegExp(`\\{\\{\\s*${from}\\s*\\}\\}`, "g");
  const wf2: DraftWorkflow = {
    ...wf,
    inputs: wf.inputs.map((i) => (i.name === from ? { ...i, name: to } : i)),
    steps: wf.steps.map((s) =>
      typeof s.value === "string" && re.test(s.value) ? { ...s, value: s.value.replace(re, `{{${to}}}`) } : s,
    ),
  };
  // Reset regex lastIndex safety: `re` is global; constructing fresh above is fine.
  return { wf: wf2 };
}

export interface StripResult {
  wf: DraftWorkflow;
  warnings: string[];
}

/**
 * Removes recorder-only artifacts so the payload passes the saved-workflow
 * contract, and collects human warnings for each adjustment.
 */
export function stripRecorderArtifacts(wf: DraftWorkflow): StripResult {
  const warnings: string[] = [];
  const steps: DraftStep[] = [];
  for (const s of wf.steps) {
    if (s.locator && typeof s.locator === "object" && "uncertain" in s.locator) {
      const { uncertain: _u, ...clean } = s.locator;
      warnings.push(`الخطوة ${s.id}: الـlocator اتسجل بطريقة غير مؤكدة (${clean.strategy}: ${clean.value}) — راجعها بعد أول تشغيل.`);
      steps.push({ ...s, locator: clean });
      continue;
    }
    steps.push(s);
  }
  // Anything explicitly non-contractual at the top level (e.g. _meta) is dropped on save.
  const wf2: DraftWorkflow = {
    schemaVersion: "0.1",
    id: wf.id,
    name: wf.name,
    allowedDomains: wf.allowedDomains,
    inputs: wf.inputs,
    steps,
    verification: wf.verification,
    policy: { autoApproveRead: true, autoApproveLocalWrite: true },
  };
  if (wf2.verification.length === 0) {
    warnings.push("مفيش تحققات — ضيف تحقق واحد على الأقل علشان التشغيل يقدر يتأكد من النتيجة.");
  }
  return { wf: wf2, warnings };
}

/** Variable names referenced by {{…}} in step values but missing from inputs. */
export function missingVariables(wf: DraftWorkflow): string[] {
  const declared = new Set(wf.inputs.map((i) => i.name));
  const used = new Set<string>();
  for (const s of wf.steps) {
    if (typeof s.value === "string") {
      for (const m of s.value.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (!declared.has(m[1]!)) used.add(m[1]!);
      }
    }
  }
  return [...used];
}

/** Suggested next variable name: var1, var2, … not colliding. */
export function nextVariableName(wf: DraftWorkflow): string {
  let i = wf.inputs.length + 1;
  while (wf.inputs.some((v) => v.name === `var${i}`)) i++;
  return `var${i}`;
}

/**
 * Merges a re-recording (made after a failed step) into the original workflow:
 * everything up to (excluding) the failed step is kept, the recorded steps
 * replace the failed step and everything after it. Recorded variables that
 * collide with original ones are renamed (rep1, rep2…) with all `{{refs}}`
 * rewritten, and recorded step ids are re-numbered to avoid collisions.
 */
export function mergeRepair(
  original: DraftWorkflow,
  failedStepId: string,
  recorded: DraftWorkflow,
): { wf: DraftWorkflow; warnings: string[] } {
  const idx = original.steps.findIndex((s) => s.id === failedStepId);
  if (idx === -1) {
    return { wf: original, warnings: [`الخطوة ${failedStepId} مش موجودة في المهارة — اتسجلت المسودة من غير دمج.`] };
  }

  const warnings: string[] = [];
  const origNames = new Set(original.inputs.map((i) => i.name));
  let recordedWf: DraftWorkflow = JSON.parse(JSON.stringify(recorded));

  // Rename colliding recorded variables and rewrite their {{refs}}.
  let counter = 1;
  for (const inp of [...recordedWf.inputs]) {
    if (origNames.has(inp.name)) {
      let newName = `rep${counter++}`;
      while (origNames.has(newName) || recordedWf.inputs.some((i) => i.name === newName)) newName = `rep${counter++}`;
      const r = renameVariable(recordedWf, inp.name, newName);
      if (!r.error) {
        recordedWf = r.wf;
        warnings.push(`متغير التسجيل ${inp.name} اتسمى ${newName} علشان ما يتعارضش مع أصل المهارة.`);
      }
    }
  }

  // Re-number recorded step ids so nothing collides with the kept originals.
  const keptIds = new Set(original.steps.slice(0, idx).map((s) => s.id));
  const repairedSteps = recordedWf.steps.map((s, i) => {
    let id = `rep_step_${i + 1}`;
    while (keptIds.has(id)) id = `${id}_x`;
    keptIds.add(id);
    return { ...s, id };
  });

  const wf: DraftWorkflow = {
    ...original,
    steps: [...original.steps.slice(0, idx), ...repairedSteps],
    inputs: [...original.inputs, ...recordedWf.inputs],
    verification: original.verification,
  };
  if (repairedSteps.length === 0) {
    warnings.push("التسجيل الجديد مفيهوش خطوات — اتأكد إنك نفّذت الخطوات في متصفح المساعد.");
  }
  return { wf, warnings };
}
