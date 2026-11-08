import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@ai-repeat/contracts";

const valid = {
  schemaVersion: "0.1",
  id: "demo_ok",
  name: "مهمة سليمة",
  allowedDomains: ["127.0.0.1"],
  inputs: [],
  steps: [{ id: "s1", action: "navigate", url: "http://127.0.0.1:4177/", risk: "read" }],
  verification: [{ kind: "url_matches", target: "http://127.0.0.1:4177/" }],
};

describe("WorkflowSchema (S12 validation contract)", () => {
  it("accepts a valid workflow", () => {
    expect(WorkflowSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects unknown action (code-level allowlist)", () => {
    const bad = { ...valid, steps: [{ id: "s1", action: "run_shell", command: "rm -rf /", risk: "read" }] };
    expect(WorkflowSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing verification", () => {
    const { verification: _v, ...noVerify } = valid as Record<string, unknown>;
    expect(WorkflowSchema.safeParse(noVerify).success).toBe(false);
  });

  it("rejects empty allowedDomains", () => {
    expect(WorkflowSchema.safeParse({ ...valid, allowedDomains: [] }).success).toBe(false);
  });

  it("rejects additional properties", () => {
    expect(WorkflowSchema.safeParse({ ...valid, sneaky: true }).success).toBe(false);
  });

  it("rejects bad step id format", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.steps[0].id = "bad id!";
    expect(WorkflowSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown risk tier", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.steps[0].risk = "whatever";
    expect(WorkflowSchema.safeParse(bad).success).toBe(false);
  });
});
