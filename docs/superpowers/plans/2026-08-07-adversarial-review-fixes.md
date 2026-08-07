# Adversarial-Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 6 findings adjudicated as Correct/Reclassify by the independent gpt-5.6-sol review of the adversarial code review.

**Architecture:** Six small, isolated fixes to existing files, each independently testable and committable. No new files, no new dependencies. The largest (Task 6) widens one function's return type and updates its mocked test call sites. Order is lowest-risk-first.

**Tech Stack:** TypeScript (ESM), Node.js `fs`/`timers`, vitest, `@earendil-works/pi-coding-agent` (`SettingsManager`). Test runner: `npx vitest run` (config in `vitest.config.ts`; include `test/**/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-08-07-adversarial-review-fixes-design.md`

## Global Constraints

- Read-only filesystem operations only where a fix changes behavior; no unrelated refactoring.
- All fixes use APIs already imported or already present in the codebase (`drainErrors`, `lstatSync`, `unlinkSync`, `readdirSync`). No new dependencies.
- Out of scope: findings #6, #8, #9 (overturned by adjudication) and the A2 prototype-pollution drop (upheld). Do NOT touch those code paths.
- Each task ends with `npm run typecheck && npx vitest run <relevant test> && npm run lint` green, then a commit.
- Run full suite (`npx vitest run`) after Task 6 (the only task with cross-file ripple).
- Existing test files follow the fs-fixture pattern: `cwd = mkdtempSync(join(tmpdir(), "pi-observers-<name>-"))` in `beforeEach`.
- Existing imports available: `commands.ts` already imports `lstatSync`, `unlinkSync`; `discovery.ts` already imports `readdirSync`; `reconciler.ts` already imports `isBlank` from `./outputs.ts`.

---

## Task 1: Deduplicate MAX_FINGERPRINT_LENGTH (Finding #7, Low)

**Files:**
- Modify: `src/reconciler.ts:1` (import), `src/reconciler.ts:21` (delete local const)
- Test: `test/reconciler.test.ts`, `test/outputs.test.ts` (existing — no new test)

**Interfaces:**
- Consumes: `MAX_FINGERPRINT_LENGTH` (exported from `src/outputs.ts:36`, already `= 512`).
- Produces: no API change. `src/reconciler.ts` now imports the constant instead of redefining it.

- [ ] **Step 1: Confirm the existing fingerprint-length tests pin the 512 boundary**

Run: `npx vitest run test/reconciler.test.ts test/outputs.test.ts`
Expected: PASS (baseline — establishes both sides already enforce 512).

- [ ] **Step 2: Replace the local constant with an import**

In `src/reconciler.ts`, change the import from `./outputs.ts` to also bring in `MAX_FINGERPRINT_LENGTH`, and delete the local declaration. The current import line is `import { isBlank } from "./outputs.ts";` (line 1) and the local `const MAX_FINGERPRINT_LENGTH = 512;` is at line 21.

Change to:
```ts
import { isBlank, MAX_FINGERPRINT_LENGTH } from "./outputs.ts";
```
And delete the line `const MAX_FINGERPRINT_LENGTH = 512;` from the constants block (keep any other constants in that block intact).

- [ ] **Step 3: Verify typecheck, tests, lint all green**

Run: `npm run typecheck && npx vitest run test/reconciler.test.ts test/outputs.test.ts && npm run lint`
Expected: PASS. `tsc` confirms the import resolves and no duplicate-declaration error.

- [ ] **Step 4: Commit**

```bash
git add src/reconciler.ts
git commit -m "reconciler: import MAX_FINGERPRINT_LENGTH from outputs.ts (fix #7)

Single source of truth for the 512-char fingerprint bound. Drift between
the output tool and the reconciler is now structurally impossible."
```

---

## Task 2: Restore normalizeModelId year range to 2000–2999 (Finding #4, Low)

**Files:**
- Modify: `src/models.ts:42` (regex)
- Test: `test/models.test.ts` (extend the `normalizeModelId (exploratory)` suite ~line 115)

**Interfaces:**
- Consumes: none.
- Produces: `normalizeModelId` now strips trailing `-YYYYMMDD` for years 2000–2999 (matching its doc comment), instead of only 2000–2099.

- [ ] **Step 1: Write the failing test**

In `test/models.test.ts`, inside `describe("normalizeModelId (exploratory)", () => { ... })` (around line 115), add this `it` block after the existing 22nd-century-related assertions (after the `model-20240132` invalid-day test at ~line 143):

```ts
  it("strips a trailing date stamp for years 2100-2999 (comment documents 2000-2999)", () => {
    // The regex must accept the full documented range, not just 2000-2099.
    expect(normalizeModelId("model-21500101")).toBe("model");
    expect(normalizeModelId("model-29991231")).toBe("model");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/models.test.ts -t "2100-2999"`
Expected: FAIL — `normalizeModelId("model-21500101")` returns `"model-21500101"` (not stripped) because `20\d{2}` only matches 2000–2099.

- [ ] **Step 3: Fix the regex**

In `src/models.ts:42`, change:
```ts
  const dateMatch = lower.match(/-(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
```
to:
```ts
  const dateMatch = lower.match(/-(2\d{3})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
```
The `Date` validation in the lines below already rejects invalid calendar dates (e.g. Feb 30), so widening the year group is safe. The comment above (line 39-40, "YYYY is 2000-2999") is now accurate — no comment edit needed.

- [ ] **Step 4: Verify the new test passes and existing tests stay green**

Run: `npx vitest run test/models.test.ts`
Expected: PASS — new 2100/2999 tests pass, existing valid-2000s and invalid-date tests still pass (the `Date` guard still rejects `20241301`, `20240132`).

- [ ] **Step 5: Commit**

```bash
git add src/models.ts test/models.test.ts
git commit -m "models: restore normalizeModelId year range to 2000-2999 (fix #4)

The diff narrowed the date-stamp regex from 2000-2999 to 2000-2099 while
the comment kept the old range. 2\d{3} restores the documented behavior;
the existing Date validation still rejects invalid calendar dates."
```

---

## Task 3: Distinguish ENOTDIR in hasDefinitions (Finding #2, Low)

**Files:**
- Modify: `src/discovery.ts:25-33` (`hasDefinitions` catch block)
- Test: `test/discovery.test.ts` (new `it` inside the existing `describe("discoverObservers", ...)` at line 26)

**Interfaces:**
- Consumes: none.
- Produces: `hasDefinitions` returns `false` for `ENOTDIR` (path is a file), so `discoverObservers()` emits no misleading "not trusted" warning for that case. Still returns `true` for `EACCES`/`EPERM`/`EIO` (so the trust warning fires and `loadDir` later reports the real error).

Note: the test file imports `discoverObservers` (not `discover`) and uses module-level fixtures `root`, `builtinDir`, `agentDir`, `cwd` set up in `beforeEach` (each test gets a fresh temp tree). `writeFileSync`, `mkdirSync`, `join` are all already imported.

- [ ] **Step 1: Write the failing test**

In `test/discovery.test.ts`, inside the existing `describe("discoverObservers", () => { ... })` (line 26), add this `it` block (e.g. after the first test at ~line 41):

```ts
  it("does not warn 'not trusted' when .pi/observers is a regular file, not a dir", () => {
    // ENOTDIR from readdirSync must not be treated as "has definitions" — a file at
    // that path is not a loadable observer dir, and the trust warning is misleading.
    const observersDir = join(cwd, ".pi", "observers");
    // beforeEach already created observersDir as a dir; replace it with a file.
    rmSync(observersDir, { recursive: true, force: true });
    writeFileSync(observersDir, "not a dir", "utf8");
    const { observers, errors } = discoverObservers({
      cwd,
      agentDir,
      builtinDir,
      projectTrusted: false,
    });
    expect(observers).toEqual([]);
    expect(errors).toEqual([]);
  });
```
Add `rmSync` to the existing `import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";` line at the top of the file (becomes `import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/discovery.test.ts -t "regular file"`
Expected: FAIL — `errors` contains the "project observers were not loaded because this project is not trusted" entry, because `hasDefinitions` returns `true` for ENOTDIR.

- [ ] **Step 3: Fix the catch block**

In `src/discovery.ts`, change the `hasDefinitions` catch block from:
```ts
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    // Permission errors (EACCES/EPERM) should not suppress the trust warning —
    // propagate as true so the caller can surface the unreadable state.
    return true;
  }
```
to:
```ts
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // Permission/I/O errors (EACCES/EPERM/EIO) should not suppress the trust
    // warning — propagate as true so the caller can surface the unreadable state,
    // and loadDir will report the concrete error once the project is trusted.
    return true;
  }
```

- [ ] **Step 4: Verify the new test passes and the existing trust-warning tests stay green**

Run: `npx vitest run test/discovery.test.ts`
Expected: PASS — new ENOTDIR test passes (no warning); existing EACCES/absent-dir tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts test/discovery.test.ts
git commit -m "discovery: treat ENOTDIR as no-definitions, not 'not trusted' (fix #2)

A regular file at .pi/observers (ENOTDIR from readdir) is not a loadable
dir; the 'not trusted' warning was misleading. EACCES/EPERM/EIO still
propagate as true so loadDir can surface the real unreadable-dir error."
```

---

## Task 4: Throw on writeMemoryNote collision exhaustion (Finding #5, Medium)

**Files:**
- Modify: `src/memory.ts:104-113` (replace destructive fallback with a throw; remove the now-dead `content` assignment)
- Test: `test/memory.test.ts` (new case in the `writeMemoryNote` suite, ~line 41)

**Interfaces:**
- Consumes: none.
- Produces: `writeMemoryNote` throws `Error` after 100 `wx` collisions instead of clobbering an existing note.

- [ ] **Step 1: Write the failing test**

In `test/memory.test.ts`, inside `describe("writeMemoryNote", () => { ... })` (line 41), add:

```ts
  it("throws after 100 slug collisions instead of overwriting an existing note", () => {
    // Pre-create 100 base-N.md files for a known slug so the wx loop exhausts.
    // The fallback must NOT clobber base-101.md (or any existing file).
    const text = "Fixed slug text here"; // deriveSlug -> "fixed-slug-text-here"
    // First, one real call to learn the slug + dir the implementation produces:
    const first = writeMemoryNote({ cwd, text });
    const base = first.slug;
    const dir = dirname(first.path);
    // Pre-create base-2.md .. base-100.md so the next call collides 100 times total
    // (base.md exists from `first`; base-2..base-100 created here; the next call
    // tries base-2..base-101 over 100 attempts and never finds a free slot).
    for (let n = 2; n <= 100; n++) {
      writeFileSync(join(dir, `${base}-${n}.md`), "pre-existing", "utf8");
    }
    // Snapshot existing files + contents (base.md + base-2..base-100 = 100 files)
    const before = new Map<string, string>();
    before.set(first.path, readFileSync(first.path, "utf8"));
    for (let n = 2; n <= 100; n++) {
      const p = join(dir, `${base}-${n}.md`);
      before.set(p, readFileSync(p, "utf8"));
    }
    expect(() => writeMemoryNote({ cwd, text })).toThrow(/100 variants/i);
    // No existing file was modified
    for (const [p, content] of before) {
      expect(readFileSync(p, "utf8")).toBe(content);
    }
  });
```
`readFileSync`, `writeFileSync`, `join` are already imported in `test/memory.test.ts` (confirmed: `import { existsSync, mkdtempSync, readFileSync } from "node:fs";` and `import { join } from "node:path";`). Add `dirname` to the `node:path` import so it becomes `import { dirname, join } from "node:path";`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/memory.test.ts -t "100 slug collisions"`
Expected: FAIL — the current fallback clobbers (no throw), OR throws a different message. Either way, the assertion `/100 variants/i` fails.

- [ ] **Step 3: Replace the destructive fallback with a throw**

In `src/memory.ts`, replace the fallback block (the lines after the `for` loop):
```ts
  // Fallback if wx loop exhausted (should not happen)
  content = `---
name: ${JSON.stringify(slug)}
description: ${JSON.stringify(deriveDescription(text))}
type: ${type}
---

${text.startsWith("---") ? `\n${text}` : text}
`;
  writeFileSync(path, content, "utf8");
  return { path, slug };
```
with:
```ts
  // 100 collisions means a runaway caller, a pathological slug, or an attack.
  // Failing loudly is correct — silently clobbering an existing note is the bug
  // the wx loop was introduced to prevent, and the fallback reintroduced it.
  throw new Error(
    `could not write memory note: "${base}" already has 100 variants on disk`,
  );
```
Note: the `content` variable is declared with `let content: string;` before the loop and assigned inside it; after this change the inner-loop assignment is the only one, which is fine (it's used by `writeFileSync` inside the loop). If `tsc` flags `content` as possibly-unassigned at the throw site, that's a false alarm (the throw doesn't read `content`), but if it flags it at the loop's `writeFileSync`, the inner assignment already covers it. Run typecheck to confirm.

- [ ] **Step 4: Verify the new test passes and existing writeMemoryNote tests stay green**

Run: `npx vitest run test/memory.test.ts`
Expected: PASS — new collision test passes (throws, no clobber); existing tests (slug collision → suffix, empty text throws, YAML frontmatter) unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/memory.ts test/memory.test.ts
git commit -m "memory: throw after 100 writeMemoryNote collisions, don't clobber (fix #5)

The wx loop fixed a TOCTOU, but its exhaustion fallback used a plain w
write that deterministically overwrote an existing note. 100 collisions
is an anomaly (runaway caller / pathological slug / attack) — surface it
instead of destroying data."
```

---

## Task 5: Reject symlinks at the goal path before writing (Finding #1, Medium/Security)

**Files:**
- Modify: `src/commands.ts:60-66` (`writeGoal`, insert lstat+unlink before the existing `writeFileSync`)
- Test: `test/commands.test.ts` (new case in a new `describe("writeGoal — goal path is a symlink", ...)`)

**Interfaces:**
- Consumes: `lstatSync`, `unlinkSync` (already imported in `commands.ts`).
- Produces: `writeGoal` removes a symlink at the goal path and writes a regular file; the symlink's target is never written through.

- [ ] **Step 1: Write the failing test**

In `test/commands.test.ts`, the current `node:fs` import (line 1) is `import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";`. Add `lstatSync` and `symlinkSync` so it becomes `import { existsSync, lstatSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";` (`dirname` is NOT imported — see Step 3 note; `writeFileSync` already imported). Then add a new `describe` block after the "goal path is a directory" suite (~line 145):

```ts
describe("writeGoal — goal path is a symlink", () => {
  it("removes the symlink and writes a regular file, never writing through to the target", () => {
    // A committed symlink at the goal path must not let /goal write goal text into
    // the symlink's target. writeGoal should unlink the symlink and write a fresh
    // regular file at the goal path.
    const target = join(cwd, "attacker-target.txt");
    writeFileSync(target, "sensitive", "utf8");
    const goalPath = goalFilePath(cwd);
    mkdirSync(dirname(goalPath), { recursive: true });
    symlinkSync(target, goalPath);

    writeGoal(cwd, "Ship the parser");

    // The symlink is gone; a regular file exists at the goal path.
    const stat = lstatSync(goalPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(readGoal(cwd)).toBe("Ship the parser");
    // The symlink's target was NOT overwritten with goal text.
    expect(readFileSync(target, "utf8")).toBe("sensitive");
  });
});
```
The test uses `dirname(goalPath)`. Check whether `dirname` is imported in `test/commands.test.ts`; if not, add it to the `node:path` import: `import { dirname, join } from "node:path";`. (The existing tests use `join` from `node:path`; `dirname` may or may not be present — verify and add if missing.) `readFileSync` is NOT currently imported in this test file — add it to the `node:fs` import line as well, so the final `node:fs` import is `import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/commands.test.ts -t "symlink"`
Expected: FAIL — the current code writes through the symlink (because `writeFileSync(path, ...)` follows the symlink before any lstat), so `target` contains "Ship the parser\n" and/or the symlink may still exist.

- [ ] **Step 3: Add the lstat-before-write guard**

In `src/commands.ts`, in `writeGoal`, find the block:
```ts
  mkdirSync(dirname(path), { recursive: true });
  // The ordinary case — an existing goal file, or no goal path at all — writes in
  // place with no pre-emptive delete. `writeFileSync` truncates-and-rewrites a plain
  // file, which keeps a crash between two /goal calls from ever losing an existing
  // goal outright.
  try {
    writeFileSync(path, `${trimmed}\n`, "utf8");
  } catch (error) {
```
Insert a symlink guard between the `mkdirSync` and the comment/`try`:
```ts
  mkdirSync(dirname(path), { recursive: true });
  // A symlink at the goal path (e.g. committed by a hostile repo) would be followed by
  // the writeFileSync below, writing goal text into the symlink's target. Remove any
  // symlink before writing so the goal always lands as a regular file at this path.
  // lstat (not stat) so a symlink is reported as a symlink even if its target is missing.
  try {
    const preStat = lstatSync(path);
    if (preStat.isSymbolicLink()) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  // The ordinary case — an existing goal file, or no goal path at all — writes in
  // place with no pre-emptive delete. `writeFileSync` truncates-and-rewrites a plain
  // file, which keeps a crash between two /goal calls from ever losing an existing
  // goal outright.
  try {
    writeFileSync(path, `${trimmed}\n`, "utf8");
  } catch (error) {
```

- [ ] **Step 4: Verify the new test passes and existing writeGoal tests stay green**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS — new symlink test passes; existing "goal path is a directory", "missing parent directory", "goal text round-tripping", "writes then reads", "clears the goal", "overwrites rather than appending" all still pass (the new guard is a no-op for non-symlink paths).

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "commands: reject a symlink at the goal path before writing (fix #1)

A committed symlink at .pi/observers/state/goal.md would let /goal write
goal text through it into an attacker-chosen target. lstat+unlink before
the write closes the static-symlink path-traversal using portable fs APIs."
```

---

## Task 6: Surface broken-settings errors through observerNotes (Finding #3, Medium)

This is the largest task. It changes `readObserverSettingsBlock`'s return type and ripples to its call site + 6 mocked test call sites. The return shape is `{ block: unknown; errors: Array<{ file: string; message: string }> }`. The mock call sites (`readSettingsBlock: () => block`) become `readSettingsBlock: () => ({ block, errors: [] })`. The corrupt-settings test flips from asserting `undefined` to asserting the error surfaces in `observerNotes`/`discoveryErrors`.

**Files:**
- Modify: `src/index.ts:416-450` (`readObserverSettingsBlock` return type + body), `src/index.ts:480` (`Deps.readSettingsBlock` type), `src/index.ts:941` (call site + merge into `discoveryErrors`), `src/index.ts` (the `ctx.ui.notify` loop near the discovery-error notify, ~line 1023)
- Modify: `test/index.test.ts` at lines 209, 669, 693, 842, 888, 1626, 1835 (update mocks to new return shape), plus the corrupt-settings test body at 669

**Interfaces:**
- Consumes: `SettingsManager.drainErrors()` (returns `Array<{ scope: "global" | "project"; error: Error }>`), `manager.globalSettingsPath` (`<agentDir>/settings.json`), `manager.projectSettingsPath` (`<cwd>/.pi/settings.json`) — all verified to exist on the manager instance.
- Produces: `readObserverSettingsBlock(cwd, projectTrusted): { block: unknown; errors: Array<{ file: string; message: string }> }`. Callers pass `block` to `parseSettings` and merge `errors` into `discoveryErrors`.

- [ ] **Step 1: Update the 6 mocked `readSettingsBlock` call sites in tests to the new shape**

In `test/index.test.ts`, each mock currently returns a bare block. Change each to return `{ block, errors: [] }`. The lines (grep-confirmed):
  - line 209: `readSettingsBlock: () => undefined,` → `readSettingsBlock: () => ({ block: undefined, errors: [] }),`
  - line 693: `readSettingsBlock: () => block,` → `readSettingsBlock: () => ({ block, errors: [] }),`
  - line 842: `readSettingsBlock: () => ({ maxAdvisoriesPerTurn: 10 }),` → `readSettingsBlock: () => ({ block: { maxAdvisoriesPerTurn: 10 }, errors: [] }),`
  - line 888: `readSettingsBlock: () => ({ maxAdvisoriesPerTurn: 10 }),` → `readSettingsBlock: () => ({ block: { maxAdvisoriesPerTurn: 10 }, errors: [] }),`
  - line 1626: `{ readSettingsBlock: () => ({ maxAdvisoriesPerTurn: 1 }) }` → `{ readSettingsBlock: () => ({ block: { maxAdvisoriesPerTurn: 1 }, errors: [] }) }`
  - line 1835: `readSettingsBlock: () => ({ vetoBudget: 1 }),` → `readSettingsBlock: () => ({ block: { vetoBudget: 1 }, errors: [] }),`

(Note: line 693 is inside the `statusWithSettings` helper defined at ~line 678, so updating 693 covers that helper.)

Do NOT yet touch line 669 (the corrupt-settings test) — that one gets rewritten in Step 5.

- [ ] **Step 2: Run the full test suite to confirm the mock updates alone don't break anything (they will, because the source still returns `unknown`)**

Run: `npx vitest run`
Expected: FAIL at the call site (`parseSettings(deps.readSettingsBlock(...))` now receives `{ block, errors }` instead of the block). This confirms the mocks are updated and the source change is required next.

- [ ] **Step 3: Change `readObserverSettingsBlock`'s return type and body**

In `src/index.ts`, change the function signature and body. Current signature:
```ts
export function readObserverSettingsBlock(cwd: string, projectTrusted: boolean): unknown {
```
New signature:
```ts
export function readObserverSettingsBlock(
  cwd: string,
  projectTrusted: boolean,
): { block: unknown; errors: Array<{ file: string; message: string }> } {
```

At the end of the `try` block, the function currently does `return Object.keys(merged).length > 0 ? merged : undefined;`. Replace that with capturing the block and draining errors:
```ts
    const block = Object.keys(merged).length > 0 ? merged : undefined;
    const errors = manager
      .drainErrors()
      .map((e) => ({
        file: e.scope === "global" ? manager.globalSettingsPath : manager.projectSettingsPath,
        message: `observer settings could not be loaded: ${String(e.error)}`,
      }));
    return { block, errors };
```
Replace the `catch` block (currently `console.warn(...); return undefined;`) with:
```ts
  } catch (error) {
    // A failure to construct/read the manager at all (not just a parse error, which
    // drainErrors covers) surfaces here. Treat it like a settings load error so the
    // user sees their disable list is not silently active.
    return { block: undefined, errors: [{ file: "settings", message: `observer settings could not be read: ${String(error)}` }] };
  }
```
Delete the now-misleading module-level-variable comment (the lines that say "The caller (session_start) renders discoveryErrors via observerNotes, so we push a synthetic entry there by storing on a module-level variable that the next session_start drains — but to keep this function pure we just warn to the console and still degrade to defaults.").

- [ ] **Step 4: Update the `Deps.readSettingsBlock` type and the call site**

In `src/index.ts:480`, change:
```ts
  readSettingsBlock: (cwd: string, projectTrusted: boolean) => unknown;
```
to:
```ts
  readSettingsBlock: (
    cwd: string,
    projectTrusted: boolean,
  ) => { block: unknown; errors: Array<{ file: string; message: string }> };
```

At the call site (`src/index.ts:941`), change:
```ts
    settings = parseSettings(deps.readSettingsBlock(ctx.cwd, ctx.isProjectTrusted()));
```
to:
```ts
    const { block: settingsBlock, errors: settingsErrors } = deps.readSettingsBlock(
      ctx.cwd,
      ctx.isProjectTrusted(),
    );
    settings = parseSettings(settingsBlock);
```

Then, after the existing `discoveryErrors` assignment (the line `discoveryErrors = errors.map((error) => ({ file: error.file, message: error.message }));` near line 1016), merge in the settings errors and notify. Change:
```ts
    discoveryErrors = errors.map((error) => ({ file: error.file, message: error.message }));
    for (const error of errors) {
      if (ctx.hasUI) ctx.ui.notify(`observer "${error.file}": ${error.message}`, "error");
    }
```
to:
```ts
    discoveryErrors = [
      ...errors.map((error) => ({ file: error.file, message: error.message })),
      ...settingsErrors,
    ];
    for (const error of errors) {
      if (ctx.hasUI) ctx.ui.notify(`observer "${error.file}": ${error.message}`, "error");
    }
    for (const error of settingsErrors) {
      if (ctx.hasUI) ctx.ui.notify(`observer settings: ${error.message}`, "error");
    }
```

- [ ] **Step 5: Flip the corrupt-settings test to assert the error surfaces**

In `test/index.test.ts:669`, replace:
```ts
  it("degrades to undefined on a corrupt settings file rather than throwing", () => {
    const path = join(cwd, CONFIG_DIR_NAME, "settings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    expect(readObserverSettingsBlock(cwd, true)).toBeUndefined();
  });
```
with:
```ts
  it("surfaces a corrupt settings file as a load error instead of silently degrading", () => {
    const projectPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, "{not json", "utf8");
    const { block, errors } = readObserverSettingsBlock(cwd, true);
    expect(block).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /could not be loaded/i.test(e.message))).toBe(true);
    expect(errors.some((e) => e.file === projectPath)).toBe(true);
  });
```
Note: confirm `readObserverSettingsBlock` is imported in this test file (it is — used at line 669 currently and 673). Also confirm the `agentDir` fixture is set up so the manager can be constructed; the existing test at 669 already constructs the manager successfully with the same setup, so no fixture change needed.

- [ ] **Step 6: Run the full suite + typecheck + lint**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: PASS — all 6 updated mocks work with the new return shape; the flipped corrupt-settings test passes (error surfaces in `errors`); no other test regressed.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "index: surface broken-settings errors via observerNotes (fix #3)

readObserverSettingsBlock now returns { block, errors } and drains the
SettingsManager's load errors into discoveryErrors, so a corrupt
settings.json no longer silently drops the user's disable list — the
error renders through the existing observerNotes channel. Drops the
misleading console.warn and module-level-variable comment."
```

---

## Final Verification

- [ ] **Full suite + typecheck + lint green across the whole branch**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: PASS. All 6 fixes applied; no regressions; the 3 overturned findings (#6, #8, #9) and the A2 drop untouched.

- [ ] **Confirm the 3 overturned findings were NOT touched**

Run: `git diff HEAD -- src/memory.ts | grep -i "EISDIR"` and `git diff HEAD -- src/index.ts | grep -i "pendingToolArgs\|oldestKey"` and `git diff HEAD -- src/models.ts | grep "\\./g"`
Expected: no changes to the EISDIR handling in memory.ts beyond the Task 4 fallback; no changes to the pendingToolArgs eviction; the `replace(/\./g, "-")` line in models.ts unchanged. (The models.ts regex change in Task 2 is on the date-match line, not the dot-replace line.)

- [ ] **Final commit log check**

Run: `git log --oneline -7`
Expected: 6 commits, one per task, in order: reconciler → models → discovery → memory → commands → index.
