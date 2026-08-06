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

/**
 * True when `error` is Node reporting that `path` refused a plain-file write because
 * something other than a regular file sits there — a directory, most commonly.
 * EISDIR is the normal signal; EPERM/EACCES are the same situation on platforms
 * (notably Windows, and some EACCES-reporting filesystems) that refuse a directory
 * write with a permissions error instead of EISDIR.
 */
function isDirectoryWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EISDIR" || code === "EPERM" || code === "EACCES";
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
  // The ordinary case — an existing goal file, or no goal path at all — writes in
  // place with no pre-emptive delete. `writeFileSync` truncates-and-rewrites a plain
  // file, which keeps a crash between two /goal calls from ever losing an existing
  // goal outright.
  try {
    writeFileSync(path, `${trimmed}\n`, "utf8");
  } catch (error) {
    if (!isDirectoryWriteError(error)) throw error;
    // Only reachable when the goal path is (or contains) a directory rather than a
    // plain file — e.g. left behind by a prior crash, or a user poking around with
    // `mkdir`. Clear it out and retry once. This costs atomicity on THIS recovery
    // path only (a crash between the rmSync and the writeFileSync below would lose
    // whatever was at `path`, but there was never a readable goal there to lose —
    // it was a directory), never on the ordinary overwrite above.
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, `${trimmed}\n`, "utf8");
  }
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

/**
 * Every codepoint some renderer -- a terminal, a markdown view, or the reading model
 * itself -- may treat as a line break. Observer `name` and `model` values come from the
 * `name:`/`model:` frontmatter fields of `.pi/observers/*.md` (see src/definitions.ts's
 * `requireString`/`parseModel`, which do nothing beyond `.trim()`), and those files are
 * project-scoped repo content -- this project already treats repo-resident files as
 * attacker-influenceable; that is the entire premise of the sanitization in
 * src/slices.ts. Left uncollapsed, a name containing one of these could inject an
 * extra apparent status row, or forge one outright (e.g. claiming another observer is
 * disabled, or reporting fabricated counts). Written as \uXXXX escapes, never
 * literal characters, so nothing here can be silently dropped in transit.
 *
 *   \r      CARRIAGE RETURN
 *   \n      LINE FEED
 *   \u0085  NEXT LINE (NEL). JavaScript's \s does NOT match it.
 *   \u000B  LINE TABULATION (VT)
 *   \u000C  FORM FEED (FF)
 *   \u2028  LINE SEPARATOR
 *   \u2029  PARAGRAPH SEPARATOR
 */
const ROW_LINE_SEPARATORS = /[\r\n\u0085\u000B\u000C\u2028\u2029]+/g;

/**
 * Cap on a rendered name/model after separator collapse, so one observer with an
 * absurdly long name cannot dominate (or, pasted enough times, visually flood) the
 * status output. 200 was picked as generously past any real observer name while still
 * bounding the row to a readable single line; there is no other size limit on this
 * field upstream.
 */
const MAX_ROW_FIELD_LENGTH = 200;

/** Collapse line-break codepoints to a space and cap length, so one row is always
 *  exactly one rendered line regardless of what a repo-resident observer file names
 *  itself. */
function sanitizeRowField(value: string): string {
  const collapsed = value.replace(ROW_LINE_SEPARATORS, " ");
  return collapsed.length > MAX_ROW_FIELD_LENGTH ? `${collapsed.slice(0, MAX_ROW_FIELD_LENGTH)}...` : collapsed;
}

export function formatObserverStatus(rows: StatusRow[]): string {
  if (rows.length === 0) return "No observers loaded.";

  return rows
    .map((row) => {
      const name = sanitizeRowField(row.name);
      const model = sanitizeRowField(row.model);
      const state = row.disabled
        ? `disabled after ${row.failures} failure${row.failures === 1 ? "" : "s"}`
        : row.enabled
          ? "on"
          : "off";

      if (!row.enabled) return `${name} [${state}] ${model}`;

      // Failures must show even when the observer is still running. An observer failing
      // intermittently but not yet at the disable threshold is exactly what a user needs
      // to see, and reporting it only after it is disabled hides the warning signal.
      // Once the observer IS disabled, the state label above already says how many
      // failures caused that — repeating the count here would double-report it.
      const parts = [`${row.runs} run${row.runs === 1 ? "" : "s"}`];
      if (!row.disabled && row.failures > 0) {
        parts.push(`${row.failures} failure${row.failures === 1 ? "" : "s"}`);
      }
      // An observer that runs constantly and has every proposal dropped is working and
      // useless, yet looks identical to a healthy one when only the run count is shown.
      // Always report both counts, even when they are zero.
      parts.push(`${row.accepted} accepted`, `${row.dropped} dropped`);
      return `${name} [${state}] ${model} — ${parts.join(", ")}`;
    })
    .join("\n");
}
