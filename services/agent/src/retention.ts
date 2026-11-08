/**
 * AI Repeat — retention enforcement (S11).
 * Physically deletes failure-evidence files older than the configured
 * retention window. Runs at boot and hourly. Deletes only inside the
 * app-owned workspace evidence folder.
 */
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";

export function pruneOldTasks(store: { pruneOldCompletedTasks(days: number): number }, days: number): number {
  return store.pruneOldCompletedTasks(days);
}

export function cleanupExpiredEvidence(workspaceRoot: string, retentionDays: number): { files: number; bytes: number } {
  const evidenceDir = path.join(workspaceRoot, "evidence");
  if (!existsSync(evidenceDir)) return { files: 0, bytes: 0 };
  const cutoff = Date.now() - retentionDays * 24 * 3600_000;
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          const st = statSync(full);
          if (st.mtimeMs < cutoff) {
            bytes += st.size;
            unlinkSync(full);
            files++;
          }
        } catch {
          /* file busy — next pass */
        }
      }
    }
  };
  walk(evidenceDir);
  return { files, bytes };
}
