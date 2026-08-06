import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface StatusRow {
  name: string;
  enabled: boolean;
  model: string;
  runs: number;
  failures: number;
  disabled: boolean;
  /** Proposals this observer had accepted by the reconciler this session. */
  accepted: number;
  /** Proposals the reconciler dropped — deduped, over-length, capped, or budget-spent. */
  dropped: number;
}

export function goalFilePath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "observers", "state", "goal.md");
}

/** Writing empty text clears the goal. Returns the stored goal, or "" if cleared.
 *
 *  `goal.md` is read by the goal-tracking observer on every settle, and that observer
 *  can veto — hold the turn open — while the goal reads as unmet. If this path were ever
 *  left as a stale directory (e.g. from a prior crash, or a user poking around with
 *  `mkdir`), a naive `rmSync(path)` throws EISDIR and the goal can never be set or
 *  cleared again. `recursive: true` handles both the ordinary file case and that
 *  directory case identically, and `force: true` makes a "goal was never set" clear a
 *  silent no-op rather than an ENOENT race against the `existsSync` check above it. */
export function writeGoal(cwd: string, text: string): string {
  const path = goalFilePath(cwd);
  const trimmed = text.trim();

  if (trimmed === "") {
    rmSync(path, { recursive: true, force: true });
    return "";
  }

  mkdirSync(dirname(path), { recursive: true });
  // Clear out a stale directory (or anything else) at the goal path before writing the
  // file — writeFileSync throws EISDIR otherwise, and that failure would surface deep
  // inside a command handler with no context about *why* setting a goal failed.
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, `${trimmed}\n`, "utf8");
  return trimmed;
}

export function readGoal(cwd: string): string | undefined {
  const path = goalFilePath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    // Covers the goal path having been replaced by a directory (or anything else
    // unreadable as a file) between the existsSync check and the read: the goal-tracking
    // observer's veto must fail open to "no goal", never throw and wedge the turn.
    return undefined;
  }
}

export function formatObserverStatus(rows: StatusRow[]): string {
  if (rows.length === 0) return "No observers loaded.";

  return rows
    .map((row) => {
      const state = row.disabled
        ? `disabled after ${row.failures} failure${row.failures === 1 ? "" : "s"}`
        : row.enabled
          ? "on"
          : "off";

      if (!row.enabled) return `${row.name} [${state}] ${row.model}`;

      // Failures must show even when the observer is still running. An observer failing
      // intermittently but not yet at the disable threshold is exactly what a user needs
      // to see, and reporting it only after it is disabled hides the warning signal.
      const parts = [`${row.runs} run${row.runs === 1 ? "" : "s"}`];
      if (!row.disabled && row.failures > 0) {
        parts.push(`${row.failures} failure${row.failures === 1 ? "" : "s"}`);
      }
      // An observer that runs constantly and has every proposal dropped is working and
      // useless, yet looks identical to a healthy one when only the run count is shown.
      // Always report both counts, even when they are zero.
      parts.push(`${row.accepted} accepted`, `${row.dropped} dropped`);
      return `${row.name} [${state}] ${row.model} — ${parts.join(", ")}`;
    })
    .join("\n");
}
