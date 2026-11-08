import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../services/agent/src/store.js";

describe("Workflow version history (FR-03)", () => {
  it("keeps every saved version and allows rollback as a new version", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-versions-"));
    const store = new Store(dir);

    const v1 = JSON.stringify({ id: "wf_v", name: "نسخة أولى" });
    store.upsertWorkflow({ id: "wf_v", json: v1 });
    const v2 = JSON.stringify({ id: "wf_v", name: "نسخة ثانية" });
    store.upsertWorkflow({ id: "wf_v", json: v2 });
    const v3 = JSON.stringify({ id: "wf_v", name: "نسخة ثالثة" });
    store.upsertWorkflow({ id: "wf_v", json: v3 });

    const versions = store.listWorkflowVersions("wf_v");
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(JSON.parse(versions[2]!.json).name).toBe("نسخة أولى");

    // Rollback: saving version 1's json creates version 4 with v1's content.
    store.upsertWorkflow({ id: "wf_v", json: store.getWorkflowVersion("wf_v", 1)! });
    const current = store.getWorkflow("wf_v") as { name: string };
    expect(current.name).toBe("نسخة أولى");
    expect(store.listWorkflowVersions("wf_v")).toHaveLength(4);
    // Version counter kept increasing — never destructive.
    expect(store.listWorkflowVersions("wf_v")[0]!.version).toBe(4);
  });

  it("returns undefined for unknown versions and empty history for unknown workflows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-versions2-"));
    const store = new Store(dir);
    expect(store.listWorkflowVersions("nope")).toEqual([]);
    expect(store.getWorkflowVersion("nope", 1)).toBeUndefined();
    store.upsertWorkflow({ id: "wf_x", json: "{}" });
    expect(store.getWorkflowVersion("wf_x", 99)).toBeUndefined();
  });
});
