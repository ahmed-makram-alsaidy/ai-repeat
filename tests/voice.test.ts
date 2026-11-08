import { describe, expect, it } from "vitest";
import { buildTaskSummaryText } from "../apps/desktop/src/lib/voice.js";

describe("buildTaskSummaryText (TTS lines)", () => {
  it("speaks success with verification for completed tasks", () => {
    const t = buildTaskSummaryText("completed", "اكتشاف الناقص صور", true);
    expect(t).toContain("اكتشاف الناقص صور");
    expect(t).toContain("اكتملت");
  });

  it("is honest when verification did not pass", () => {
    const t = buildTaskSummaryText("completed", "مهمة", false);
    expect(t).toContain("التحقق مأكدش");
  });

  it("covers failure, cancellation and approval states", () => {
    expect(buildTaskSummaryText("failed", "م")).toContain("فشلت");
    expect(buildTaskSummaryText("cancelled", "م")).toContain("اتلغت");
    expect(buildTaskSummaryText("awaiting_approval", "م")).toContain("موافقتك");
    expect(buildTaskSummaryText("running", "م")).toBe("");
  });
});
