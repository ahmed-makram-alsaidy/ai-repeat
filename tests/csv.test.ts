import { describe, expect, it } from "vitest";
import { csvPreview, parseCsv } from "../apps/desktop/src/lib/csv.js";

describe("parseCsv", () => {
  it("parses plain rows with CRLF and strips the BOM", () => {
    const rows = parseCsv("\uFEFFa,b\r\n1,2\r\n");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('name,note\n"Ali, Jr","said ""hi"""');
    expect(rows).toEqual([
      ["name", "note"],
      ["Ali, Jr", 'said "hi"'],
    ]);
  });

  it("keeps empty fields and a trailing row without newline", () => {
    const rows = parseCsv("a,,c\n1,,3\nx,y,z");
    expect(rows).toEqual([
      ["a", "", "c"],
      ["1", "", "3"],
      ["x", "y", "z"],
    ]);
  });

  it("handles Arabic content", () => {
    const rows = parseCsv("الكود,المنتج\nSKU-001,زيت زيتون");
    expect(rows[1]).toEqual(["SKU-001", "زيت زيتون"]);
  });
});

describe("csvPreview", () => {
  it("returns headers, limited rows and truncation info", () => {
    const csv = "h1,h2\n" + Array.from({ length: 25 }, (_, i) => `${i},x`).join("\n");
    const p = csvPreview(csv, 10);
    expect(p.headers).toEqual(["h1", "h2"]);
    expect(p.rows).toHaveLength(10);
    expect(p.totalRows).toBe(25);
    expect(p.truncated).toBe(true);
  });

  it("drops fully-empty trailing rows", () => {
    const p = csvPreview("h\n1\n\n");
    expect(p.totalRows).toBe(1);
    expect(p.truncated).toBe(false);
  });
});
