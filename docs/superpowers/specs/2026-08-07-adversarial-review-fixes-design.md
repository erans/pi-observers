# Design: Fix the 6 Confirmed Adversarial-Review Findings

**Date:** 2026-08-07
**Status:** Approved (pending user spec review)
**Scope:** The 6 findings adjudicated as Correct or Reclassified by the independent
gpt-5.6-sol (xhigh) reviewer. Three overturned findings and one dropped false positive
are explicitly out of scope.

## Background

An adversarial code review (two competing reviewers on the session model
`lunaroute/glm-5.2-vision-background`) examined the uncommitted working-tree changes
in this repo (`git diff HEAD -- src/ test/`). Their merged findings were independently
adjudicated by a `gpt-reviewer` agent (gpt-5.6-sol, xhigh thinking) against the actual
code on disk. The adjudication confirmed 6 real issues and overturned 3 as false
positives; 1 dropped false positive was upheld.

This spec fixes the 6 confirmed findings. It does **not** touch the 3 overturned
findings (#6 EISDIR wedge — Linux `wx` returns `EEXIST` for a directory, not EISDIR;
#8 LRU-vs-FIFO — entries are deleted, not re-accessed, so insertion age == last-use
age; #9 dot→dash date stripping — explicitly intended by the documented contract).

## Confirmed findings (adjudicated)

| # | Severity | Category | Location | Issue |
|---|----------|----------|----------|-------|
| 1 | Medium | Security | `src/commands.ts:63-83` | `writeGoal` writes through a planted symlink before any `lstat` check — path-traversal write of the user's goal text into an attacker-chosen target. |
| 2 | Low | Correctness | `src/discovery.ts:25-33` | `hasDefinitions` returns `true` for `ENOTDIR` (path is a file), mislabeling it as "has definitions" and emitting a misleading "not trusted" warning. |
| 3 | Medium | Correctness | `src/index.ts:416-450` | `readObserverSettingsBlock` catch only `console.warn`s and returns `undefined`; the comment promises to surface broken-settings errors via `observerNotes`, but no such plumbing exists. A corrupt `settings.json` silently drops the user's `disable` list. |
| 4 | Low | Correctness (regression) | `src/models.ts:42` | `normalizeModelId` date regex narrowed from 2000–2999 to 2000–2099; the comment still says "2000-2999." |
| 5 | Medium | Concurrency | `src/memory.ts:104-113` | `writeMemoryNote` fallback after 100 `wx` collisions drops `wx` (default `w`), deterministically clobbering an existing `base-101.md`. |
| 7 | Low | Maintainability | `src/reconciler.ts:21` vs `src/outputs.ts:36` | Duplicate `MAX_FINGERPRINT_LENGTH = 512` with no shared source of truth; future drift causes silent dedupe divergence across reloads. |

(#6, #8, #9 are out of scope — overturned. Alpha's A2 prototype-pollution drop stands.)

## Design decisions (chosen approaches)

- **#1 → Approach A** (lstat-before-write, portable `fs` APIs). Chosen over O_NOFOLLOW fd-based (B) for portability, and over realpath allowlist (C) which has its own TOCTOU. Residual lstat→write TOCTOU is not realistic in pi's local single-user model.
- **#3 → Approach A** (route into the existing `observerNotes`/`discoveryErrors` channel via the manager's `drainErrors()`). Chosen over a separate `settingsErrors` channel (B, duplicate plumbing) and over a one-off `ctx.ui.notify` toast (C, transient, not reviewable). Actually fulfills the comment's stated intent.
- **#5 → Approach A** (throw after 100 collisions instead of overwriting). Chosen over UUID-suffix retry (B, dead-code path maintained forever) and over raising the cap (C, doesn't fix the determinism bug). 100 collisions is an anomaly worth surfacing, not papering over.
- **#2, #4, #7** each have one obvious best fix (no real fork): distinguish `ENOTDIR`; restore `2\d{3}`; import the shared constant.

## Changes by file

### 1. `src/commands.ts` — `writeGoal` (Finding #1, Medium/Security)

Add a `lstatSync(path)` check **before** the first `writeFileSync`. If the path is a
symlink, `unlinkSync` it first; then write a regular file. The existing EISDIR
recovery block stays as the fallback for the directory-at-path case.

```ts
mkdirSync(dirname(path), { recursive: true });
try {
  const stat = lstatSync(path);          // NEW: inspect before write
  if (stat.isSymbolicLink()) unlinkSync(path);
} catch (error) {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
}
try {
  writeFileSync(path, `${trimmed}\n`, "utf8");   // now safe: no symlink to follow
} catch (error) {
  if (!isDirectoryWriteError(error)) throw error;
  // ... existing EISDIR recovery unchanged ...
}
```

`lstatSync` and `unlinkSync` are already imported in this file (used by the existing
EISDIR recovery). No new imports.

**Behavior preserved:** empty trim (rm), normal file rewrite, directory-at-path
recovery. **New behavior:** a symlink at the goal path is removed and replaced with a
regular goal file; the symlink target is never written through.

### 2. `src/discovery.ts` — `hasDefinitions` (Finding #2, Low)

Distinguish `ENOTDIR` (path is a file) from genuine unreadable-dir errors. Return
`false` for `ENOTDIR` (no misleading "not trusted" warning); keep `true` for
`EACCES`/`EPERM`/`EIO` (surface the trust warning → user trusts → `loadDir` reports
the real unreadable error).

```ts
function hasDefinitions(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => entry.endsWith(".md"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // Permission/I/O errors: propagate as true so the caller can surface
    // the unreadable state (loadDir will report the concrete error once trusted).
    return true;
  }
}
```

### 3. `src/index.ts` — settings-error channel (Finding #3, Medium)

Change `readObserverSettingsBlock` to return `{ block: unknown; errors:
Array<{ file: string; message: string }> }` instead of bare `unknown`. After loading,
call the manager's `drainErrors()` to collect any global/project load errors and
translate them to `{ file, message }` entries (file = the settings file path). Drop the
misleading `console.warn` and the module-level-variable comment.

At the call site (`index.ts:941`), destructure `{ block, errors }`, pass `block` to
`parseSettings`, and merge `errors` into `discoveryErrors` (the existing array that
`observerNotes` renders and that `ctx.ui.notify` surfaces per-error at session start).

```ts
// readObserverSettingsBlock — new return shape
// manager.drainErrors() returns Array<{ scope: "global" | "project"; error: Error }>
// manager.globalSettingsPath = <agentDir>/settings.json ; manager.projectSettingsPath = <cwd>/.pi/settings.json
export function readObserverSettingsBlock(
  cwd: string,
  projectTrusted: boolean,
): { block: unknown; errors: Array<{ file: string; message: string }> } {
  const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const global = manager.getGlobalSettings() as unknown as Record<string, unknown>;
  const project = manager.getProjectSettings() as unknown as Record<string, unknown>;
  // ... existing merge logic, applied to `block` instead of returned directly ...
  const settingsErrors = manager.drainErrors().map((e) => ({
    file: e.scope === "global" ? manager.globalSettingsPath : manager.projectSettingsPath,
    message: `observer settings could not be loaded: ${String(e.error)}`,
  }));
  return { block: mergedOrUndefined, errors: settingsErrors };
}

// call site (session start)
const { block, errors: settingsErrors } = deps.readSettingsBlock(
  ctx.cwd,
  ctx.isProjectTrusted(),
);
settings = parseSettings(block);
const { observers, errors } = deps.discover({ /* ... */ });
discoveryErrors = [
  ...errors.map((error) => ({ file: error.file, message: error.message })),
  ...settingsErrors,
];
for (const error of settingsErrors) {
  if (ctx.hasUI) ctx.ui.notify(`observer settings: ${error.message}`, "error");
}
```

**Ripple:** the `Deps.readSettingsBlock` type signature (`index.ts:480`) updates to the
new return type. `drainErrors()` already exists on `SettingsManager` and returns
`Array<{ scope: "global" | "project"; error: Error }>`; the manager exposes
`globalSettingsPath` (`<agentDir>/settings.json`) and `projectSettingsPath`
(`<cwd>/.pi/settings.json`) as instance fields (verified in
`node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js:42-47, 420`).

### 4. `src/models.ts` — `normalizeModelId` (Finding #4, Low)

Restore the 2000–2999 range the comment documents. One-character change: `20\d{2}` →
`2\d{3}`. The `Date` validation below already rejects invalid calendar dates, so
widening the regex is safe.

```ts
const dateMatch = lower.match(/-(2\d{3})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
```

The comment ("YYYY is 2000-2999") is now true again. No comment edit needed.

### 5. `src/memory.ts` — `writeMemoryNote` (Finding #5, Medium)

Replace the destructive fallback with a thrown error. After 100 `wx` collisions, 100
notes already exist with the same slug — a runaway caller, pathological slug, or
attack; failing loudly is correct, clobbering is the bug.

```ts
// Fallback if wx loop exhausted: do NOT fall back to a destructive overwrite.
// 100 collisions means a runaway caller, a pathological slug, or an attack;
// failing loudly is correct — silently clobbering an existing note is the bug.
throw new Error(
  `could not write memory note: "${base}" already has 100 variants on disk`,
);
```

The `content` variable assignment that currently precedes the fallback
`writeFileSync` can be removed (it's now dead).

### 6. `src/reconciler.ts` — duplicate constant (Finding #7, Low)

Delete `const MAX_FINGERPRINT_LENGTH = 512;` (line 21) and import it from `./outputs.ts`,
which already exports it. `isBlank` is already imported from there.

```ts
import { isBlank, MAX_FINGERPRINT_LENGTH } from "./outputs.ts";
```

Single source of truth; future drift structurally impossible.

## Testing

Each fix gets a targeted test, following the existing fs-fixture test pattern already
used in `test/commands.test.ts:131` ("goal path is a directory").

- **#1:** Extend `test/commands.test.ts` goal-path suite. Plant a symlink at
  `goalFilePath(cwd)` → a temp file; call `writeGoal`; assert the symlink is gone, a
  regular file exists at the goal path with the goal content, and the symlink's target
  was **not** written through.
- **#2:** New `test/discovery.test.ts` case: create a regular **file** at
  `.pi/observers` (not a dir) in an untrusted project; assert `discover()` returns no
  observers and no trust-warning error. (Existing coverage already asserts the
  absent-dir silent case.)
- **#3:** Flip the existing `test/index.test.ts:669` test ("degrades to undefined on
  a corrupt settings file rather than throwing") to assert the error now appears in
  `observerNotes()`/`discoveryErrors` (and is notified via `ctx.ui.notify`).
- **#4:** New `test/models.test.ts` case: `normalizeModelId("model-21500101")` →
  `"model"` (previously not stripped). Keep/extend the existing valid-2000s and
  invalid-date cases.
- **#5:** New `test/memory.test.ts` case: pre-create 100 `base-N.md` files for a
  known slug; call `writeMemoryNote` with the same slug; assert it throws and that
  none of the 100 existing files were modified.
- **#7:** No new test. Existing fingerprint-length tests in `reconciler.test.ts` and
  `outputs.test.ts` already pin the 512 boundary on both sides; the divergence is now
  structurally impossible. Confirm `npm test` + `npm run typecheck` stay green.

## Cross-cutting concerns

- **Out of scope:** findings #6, #8, #9 (overturned) and the A2 drop (upheld). No
  changes to those code paths.
- **No new dependencies.** All fixes use APIs already imported or already present in
  the codebase (`drainErrors` already on `SettingsManager`; `lstatSync`/`unlinkSync`
  already imported in `commands.ts`).
- **No new user-facing config or behavior** beyond: a symlink at the goal path is now
  removed (security fix); a 100-collision `/remember` now errors instead of clobbering
  (correctness fix); a corrupt `settings.json` now surfaces an error instead of
  silently degrading (correctness fix).
- **Verification gate:** after implementation, run
  `npm run typecheck && npm test && npm run lint` and confirm all green before claiming
  done.

## Order of work (lowest-risk-first, each independently testable)

1. **#7** (delete dup constant + import) — trivial, unblocks nothing.
2. **#4** (regex one-char) — trivial.
3. **#2** (ENOTDIR branch) — small, isolated to discovery.
4. **#5** (throw on exhaustion) — small, isolated to memory.
5. **#1** (lstat before write) — small, security; test needs symlink fixture.
6. **#3** (settings error channel) — largest; signature change + call site + test flip,
   do last.

Each step is independently testable and committable.
