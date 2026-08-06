import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
 * Only EISDIR is treated as a directory signal here; EPERM/EACCES are surfaced
 * to the caller, because deleting on a permission error would remove a file the
 * user cannot write to. Callers that need Windows EPERM-for-directory handling
 * must verify with stat before deleting.
 */
function isDirectoryWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EISDIR";
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
    // Verify the path really is a directory before deleting. EPERM/EACCES are no
    // longer treated as directory signals above, and even EISDIR is double-checked
    // to avoid deleting a symlink to a file via recursive rm (Node's rmSync on a
    // directory symlink removes the symlink itself, but we prefer explicit unlink).
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        unlinkSync(path);
      } else if (!stat.isDirectory()) {
        throw error;
      } else {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // If lstat fails, fall back to recursive remove for EISDIR case (original behavior)
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        throw error;
      }
    }
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
 *   \u001C  FILE SEPARATOR (FS)
 *   \u001D  GROUP SEPARATOR (GS)
 *   \u001E  RECORD SEPARATOR (RS)
 *   \u2028  LINE SEPARATOR
 *   \u2029  PARAGRAPH SEPARATOR
 */
// Written as escapes in a string, not as a literal character class: typing these
// codepoints directly has repeatedly ended up as literal control bytes on disk in this
// repo, and a literal control character in a regex is also a biome error.
const ROW_SEPARATOR_CHARS = "\\r\\n\\u0085\\u000B\\u000C\\u001C\\u001D\\u001E\\u2028\\u2029";
const ROW_LINE_SEPARATORS = new RegExp(
  // All ten codepoints a terminal, a pager, or a JS engine may treat as a line break.
  // The three C0 separators (U+001C..U+001E) are the ones most easily forgotten and the
  // ones a definition author is most likely to reach for precisely because they are:
  // they are invisible, they are not matched by \s in every tool, and several terminals
  // render them as a line break. Kept in step with src/index.ts's LINE_SEPARATOR_CHARS
  // and src/slices.ts.
  `[${ROW_SEPARATOR_CHARS}]+`,
  "g",
);

/**
 * Cap on a rendered name/model after separator collapse, so one observer with an
 * absurdly long name cannot dominate (or, pasted enough times, visually flood) the
 * status output. 200 was picked as generously past any real observer name while still
 * bounding the row to a readable single line; there is no other size limit on this
 * field upstream.
 */
const MAX_ROW_FIELD_LENGTH = 200;

/**
 * Truncate to `maxCodePoints` code points, never splitting a surrogate pair. A plain
 * `value.slice(0, n)` counts UTF-16 units, not code points, so a name whose cap
 * happens to land inside an astral character (emoji, etc.) would emit a lone
 * high surrogate — the same bug class Task 5 fixed for `src/slices.ts`'s per-field
 * caps; this project should not disagree with itself about whether that matters.
 */
function truncateCodePoints(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  return points.length <= maxCodePoints ? value : points.slice(0, maxCodePoints).join("");
}

/** Collapse line-break codepoints to a space and cap length, so one row is always
 *  exactly one rendered line regardless of what a repo-resident observer file names
 *  itself. */
function sanitizeRowField(value: string): string {
  const collapsed = value.replace(ROW_LINE_SEPARATORS, " ");
  const truncated = truncateCodePoints(collapsed, MAX_ROW_FIELD_LENGTH);
  return truncated.length < collapsed.length ? `${truncated}...` : collapsed;
}

export function formatObserverStatus(rows: StatusRow[]): string {
  if (rows.length === 0) return "No observers loaded.";

  return rows
    .map((row) => {
      const name = sanitizeRowField(row.name);
      const model = sanitizeRowField(row.model);
      const state = row.disabled
        ? // "after N failures" invites the reader to compare N against the threshold,
          // which is 3 CONSECUTIVE failures -- so an observer that failed once,
          // recovered, then failed three times rendered "disabled after 4 failures" and
          // sent the reader looking for a fourth consecutive failure that never
          // happened. Say which count this is rather than leaving it to be inferred.
          `disabled; ${row.failures} failure${row.failures === 1 ? "" : "s"} in total`
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
