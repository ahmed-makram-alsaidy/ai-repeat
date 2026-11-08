import { describe, expect, it } from "vitest";
import {
  mergeRepair,
  missingVariables,
  nextVariableName,
  parseDraft,
  renameVariable,
  stripRecorderArtifacts,
  type DraftWorkflow,
} from "../apps/desktop/src/lib/step-editor.js";

const draftJson = JSON.stringify({
  schemaVersion: "0.1",
  id: "taught_abc",
  name: "مسودة",
  allowedDomains: ["127.0.0.1"],
  inputs: [{ name: "var1", type: "string", required: true, description: "اسم العميل" }],
  steps: [
    { id: "step_1", action: "navigate", url: "http://127.0.0.1:4177/drafts/new", risk: "read", summary: "فتح النموذج" },
    {
      id: "step_2",
      action: "fill",
      locator: { strategy: "label", value: "اسم العميل" },
      value: "{{var1}}",
      risk: "read",
    },
    {
      id: "step_3",
      action: "click",
      locator: { strategy: "css", value: "#submit-btn", uncertain: true },
      risk: "external_write",
      requiresApproval: true,
    },
  ],
  verification: [{ kind: "url_matches", target: "*:" }],
  _meta: { note: "draft-only" },
});

describe("parseDraft", () => {
  it("parses a recorder draft and tolerates extra keys", () => {
    const r = parseDraft(draftJson);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wf.steps).toHaveLength(3);
      expect(r.wf.inputs[0]?.name).toBe("var1");
    }
  });

  it("rejects broken JSON with the parse error", () => {
    const r = parseDraft("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON غير صالح");
  });

  it("rejects drafts without steps or domains", () => {
    expect(parseDraft('{"schemaVersion":"0.1","id":"abc","allowedDomains":["x"],"steps":[]}').ok).toBe(false);
    expect(parseDraft('{"schemaVersion":"0.1","id":"abc","steps":[{"id":"a","action":"navigate","risk":"read"}],"verification":[]}').ok).toBe(false);
  });
});

describe("renameVariable", () => {
  const wf = (parseDraft(draftJson) as { ok: true; wf: DraftWorkflow }).wf;

  it("renames the input and every {{ref}} in step values", () => {
    const { wf: renamed, error } = renameVariable(wf, "var1", "customer_name");
    expect(error).toBeUndefined();
    expect(renamed.inputs[0]?.name).toBe("customer_name");
    expect(renamed.steps[1]?.value).toBe("{{customer_name}}");
  });

  it("refuses invalid or colliding names", () => {
    expect(renameVariable(wf, "var1", "9bad")?.error).toContain("اسم المتغير");
    const withSecond = { ...wf, inputs: [...wf.inputs, { name: "customer", type: "string", required: true }] };
    expect(renameVariable(withSecond, "var1", "customer")?.error).toContain("تاني اسمه");
  });
});

describe("stripRecorderArtifacts", () => {
  it("strips locator.uncertain and _meta, warns per stripped locator", () => {
    const wf = (parseDraft(draftJson) as { ok: true; wf: DraftWorkflow }).wf;
    const { wf: clean, warnings } = stripRecorderArtifacts(wf);
    expect(clean.steps[2]?.locator).toEqual({ strategy: "css", value: "#submit-btn" });
    expect(clean.steps[2]).not.toHaveProperty("uncertain");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("غير مؤكدة");
    expect(JSON.stringify(clean)).not.toContain("_meta");
    expect(clean.policy).toEqual({ autoApproveRead: true, autoApproveLocalWrite: true });
  });

  it("warns when verification is empty", () => {
    const wf = (parseDraft(draftJson) as { ok: true; wf: DraftWorkflow }).wf;
    const { warnings } = stripRecorderArtifacts({ ...wf, verification: [] });
    expect(warnings.some((w) => w.includes("مفيش تحققات"))).toBe(true);
  });
});

describe("missingVariables / nextVariableName", () => {
  it("detects {{refs}} not declared in inputs", () => {
    const wf = (parseDraft(draftJson) as { ok: true; wf: DraftWorkflow }).wf;
    const withGhost: DraftWorkflow = {
      ...wf,
      steps: [...wf.steps, { id: "s4", action: "fill", locator: wf.steps[1]!.locator, value: "{{ghost_var}}", risk: "read" }],
    };
    expect(missingVariables(withGhost)).toEqual(["ghost_var"]);
    expect(missingVariables(wf)).toEqual([]);
  });

  it("suggests a non-colliding variable name", () => {
    const wf = (parseDraft(draftJson) as { ok: true; wf: DraftWorkflow }).wf;
    expect(nextVariableName(wf)).toBe("var2");
  });
});

describe("mergeRepair", () => {
  const original = (parseDraft(draftJson) as { ok: true; wf: DraftWorkflow }).wf; // 3 steps: navigate, fill var1, click(uncertain submit)

  const recorded = (parseDraft(
    JSON.stringify({
      schemaVersion: "0.1",
      id: "recorded_repair",
      name: "تسجيل إصلاح",
      allowedDomains: ["127.0.0.1"],
      inputs: [
        { name: "var1", type: "string", required: true, description: "متغير متعارض" },
        { name: "var9", type: "string", required: true, description: "متغير جديد" },
      ],
      steps: [
        { id: "step_1", action: "fill", locator: { strategy: "label", value: "اسم العميل" }, value: "{{var1}}", risk: "read" },
        { id: "step_2", action: "fill", locator: { strategy: "label", value: "الكمية" }, value: "{{var9}}", risk: "read" },
      ],
      verification: [],
    }),
  ) as { ok: true; wf: DraftWorkflow }).wf;

  it("replaces the failed step and everything after it with the re-recording", () => {
    const { wf: merged, warnings } = mergeRepair(original, "step_3", recorded);
    // original kept: step_1 (navigate), step_2 (fill var1); failed step_3 (+ anything after) replaced by the 2 recorded steps.
    expect(merged.steps).toHaveLength(4);
    expect(merged.steps.map((s) => s.id)).toEqual(["step_1", "step_2", "rep_step_1", "rep_step_2"]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("renames colliding recorded variables and rewrites their refs", () => {
    const { wf: merged, warnings } = mergeRepair(original, "step_3", recorded);
    // recorded var1 collided with original var1 → renamed rep1
    const repFill = merged.steps.find((s) => s.id === "rep_step_1")!;
    expect(repFill.value).toBe("{{rep1}}");
    expect(merged.inputs.map((i) => i.name).sort()).toEqual(["rep1", "var1", "var9"]);
    expect(warnings.some((w) => w.includes("rep1"))).toBe(true);
    // no ghost variables after merge
    expect(missingVariables(merged)).toEqual([]);
  });

  it("returns the original untouched with a warning when the step id is unknown", () => {
    const { wf: merged, warnings } = mergeRepair(original, "nope", recorded);
    expect(merged).toBe(original);
    expect(warnings[0]).toContain("nope");
  });
});
