/**
 * AI Repeat — minimal CSV parsing for artifact previews (pure, unit-tested).
 * Handles BOM, quoted fields, escaped quotes, CRLF/LF.
 */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

export function csvPreview(input: string, maxRows = 10): CsvPreview {
  const all = parseCsv(input);
  const headers = all[0] ?? [];
  const rest = all.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  return {
    headers,
    rows: rest.slice(0, maxRows),
    totalRows: rest.length,
    truncated: rest.length > maxRows,
  };
}
