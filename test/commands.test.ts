import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { formatObserverStatus, goalFilePath, readGoal, writeGoal } from "../src/commands.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-observers-cmd-"));
});

describe("goal file", () => {
  it("returns undefined when no goal is set", () => {
    expect(readGoal(cwd)).toBeUndefined();
  });

  it("writes then reads a goal", () => {
    writeGoal(cwd, "Ship the parser");
    expect(readGoal(cwd)).toBe("Ship the parser");
    expect(existsSync(goalFilePath(cwd))).toBe(true);
  });

  it("clears the goal when given empty text", () => {
    writeGoal(cwd, "Ship the parser");
    writeGoal(cwd, "   ");
    expect(readGoal(cwd)).toBeUndefined();
  });

  it("overwrites rather than appending", () => {
    writeGoal(cwd, "First");
    writeGoal(cwd, "Second");
    expect(readGoal(cwd)).toBe("Second");
  });
});

describe("formatObserverStatus", () => {
  it("says so when nothing is loaded", () => {
    expect(formatObserverStatus([])).toMatch(/no observers/i);
  });

  it("lists each observer with model and counts", () => {
    const out = formatObserverStatus([
      {
        name: "memory-recall",
        enabled: true,
        model: "lunaroute/deepseek-v4-flash",
        runs: 3,
        failures: 0,
        disabled: false,
        accepted: 2,
        dropped: 1,
      },
      { name: "verification", enabled: false, model: "-", runs: 0, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    expect(out).toContain("memory-recall");
    expect(out).toContain("lunaroute/deepseek-v4-flash");
    expect(out).toContain("verification");
    expect(out).toMatch(/disabled|off/i);
  });

  it("reports accepted and dropped counts, not just runs", () => {
    // An observer that runs constantly and has everything dropped is working and
    // useless; with only a run count it looks identical to a healthy one.
    const out = formatObserverStatus([
      { name: "noisy", enabled: true, model: "m", runs: 9, failures: 0, disabled: false, accepted: 0, dropped: 9 },
    ]);
    expect(out).toMatch(/0 accepted/);
    expect(out).toMatch(/9 dropped/);
  });

  it("shows failures for an observer that is failing but not yet disabled", () => {
    // Reporting failures only after the disable threshold hides the warning signal.
    const out = formatObserverStatus([
      { name: "shaky", enabled: true, model: "m", runs: 5, failures: 2, disabled: false, accepted: 1, dropped: 0 },
    ]);
    expect(out).toMatch(/2 failures/);
  });

  it("flags an observer disabled by repeated failures", () => {
    const out = formatObserverStatus([
      { name: "flaky", enabled: true, model: "m", runs: 3, failures: 3, disabled: true, accepted: 0, dropped: 0 },
    ]);
    expect(out).toMatch(/failure/i);
  });
});

// --- Exploratory tests beyond the brief ---------------------------------------------
//
// The brief's own tests were written by the same person who wrote the implementation,
// so they share whatever blind spots that person had. `goal.md` in particular feeds a
// mechanism that can veto (hold open) a turn, so a wrongly-written or wrongly-cleared
// file has a visible, user-facing consequence — these probe the ways that can go wrong.

describe("writeGoal — goal path is a directory, not a file", () => {
  it("sets a goal even when something has left a directory at the goal path", () => {
    // A naive `rmSync(path)` (no `recursive`) throws EISDIR on a directory. If that
    // ever happened here, /goal would be permanently broken for this project until
    // someone manually deleted the stray directory — with no clear error explaining why.
    mkdirSync(goalFilePath(cwd), { recursive: true });
    expect(() => writeGoal(cwd, "Ship the parser")).not.toThrow();
    expect(readGoal(cwd)).toBe("Ship the parser");
  });

  it("clears a directory left at the goal path without throwing", () => {
    mkdirSync(join(goalFilePath(cwd), "nested"), { recursive: true });
    expect(() => writeGoal(cwd, "   ")).not.toThrow();
    expect(existsSync(goalFilePath(cwd))).toBe(false);
  });
});

describe("writeGoal — missing parent directory", () => {
  it("creates the full .../observers/state chain from a bare temp dir", () => {
    // mkdtempSync gives us only the bare cwd — none of CONFIG_DIR_NAME/observers/state
    // exists yet. This is the ordinary first-ever /goal call, not a special case.
    expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(false);
    writeGoal(cwd, "Ship the parser");
    expect(existsSync(goalFilePath(cwd))).toBe(true);
  });
});

describe("goal text round-tripping", () => {
  it("preserves internal newlines exactly, trimming only the outer edges", () => {
    const text = "  Line one\n\nLine three  ";
    writeGoal(cwd, text);
    expect(readGoal(cwd)).toBe("Line one\n\nLine three");
  });

  it("round-trips a very long goal without truncation", () => {
    const text = `Ship: ${"x".repeat(50_000)}`;
    writeGoal(cwd, text);
    expect(readGoal(cwd)).toBe(text);
    expect(readGoal(cwd)?.length).toBe(text.length);
  });

  it("clearing a goal that was never set does not throw and leaves no file", () => {
    expect(() => writeGoal(cwd, "")).not.toThrow();
    expect(writeGoal(cwd, "")).toBe("");
    expect(existsSync(goalFilePath(cwd))).toBe(false);
    expect(readGoal(cwd)).toBeUndefined();
  });

  it("treats an empty file at the goal path as no goal", () => {
    mkdirSync(join(cwd, CONFIG_DIR_NAME, "observers", "state"), { recursive: true });
    writeFileSync(goalFilePath(cwd), "", "utf8");
    expect(readGoal(cwd)).toBeUndefined();
  });

  it("treats a whitespace-only file at the goal path as no goal", () => {
    mkdirSync(join(cwd, CONFIG_DIR_NAME, "observers", "state"), { recursive: true });
    writeFileSync(goalFilePath(cwd), "   \n\n  \t\n", "utf8");
    expect(readGoal(cwd)).toBeUndefined();
  });

  it("never lets the goal text influence the file path written to", () => {
    // The only thing that should ever determine the path is `cwd` plus the fixed
    // CONFIG_DIR_NAME/observers/state/goal.md suffix — never anything from `text`.
    writeGoal(cwd, "../../../etc/passwd\nrm -rf /");
    const outside = join(cwd, "..", "etc", "passwd");
    expect(existsSync(outside)).toBe(false);
    expect(readGoal(cwd)).toBe("../../../etc/passwd\nrm -rf /");
  });
});

describe("goalFilePath", () => {
  it("always resolves under <cwd>/<CONFIG_DIR_NAME>/observers/state, never .pi hardcoded", () => {
    const path = goalFilePath(cwd);
    expect(path).toBe(join(cwd, CONFIG_DIR_NAME, "observers", "state", "goal.md"));
    expect(path.startsWith(join(cwd, CONFIG_DIR_NAME))).toBe(true);
  });
});

describe("formatObserverStatus — exploratory", () => {
  it("reports zero runs explicitly rather than omitting the observer's counts", () => {
    const out = formatObserverStatus([
      { name: "fresh", enabled: true, model: "m", runs: 0, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    expect(out).toMatch(/0 runs/);
    expect(out).toMatch(/0 accepted/);
    expect(out).toMatch(/0 dropped/);
  });

  it("still reports accepted/dropped for an observer that is both disabled and has history", () => {
    // An observer disabled by repeated failures may have accepted proposals earlier in
    // the session, before it started failing. That history must not disappear once the
    // observer trips the disable threshold.
    const out = formatObserverStatus([
      { name: "was-good", enabled: true, model: "m", runs: 10, failures: 3, disabled: true, accepted: 5, dropped: 2 },
    ]);
    expect(out).toMatch(/5 accepted/);
    expect(out).toMatch(/2 dropped/);
  });

  it("reports the real counts even when the observer's name itself looks like a count", () => {
    // Guards against an assertion (or an implementation) that merely checks the
    // substring "3 accepted" is present, which a name like this would satisfy by
        // accident even if the actual accepted count were wrong.
    const out = formatObserverStatus([
      { name: "0 accepted 9 dropped", enabled: true, model: "m", runs: 1, failures: 0, disabled: false, accepted: 3, dropped: 4 },
    ]);
    const afterName = out.slice(out.indexOf("0 accepted 9 dropped") + "0 accepted 9 dropped".length);
    expect(afterName).toMatch(/3 accepted/);
    expect(afterName).toMatch(/4 dropped/);
  });

  it("keeps rows on separate lines and names intact when a name carries bracket characters", () => {
    const out = formatObserverStatus([
      { name: "weird[name]", enabled: true, model: "m", runs: 1, failures: 0, disabled: false, accepted: 1, dropped: 0 },
      { name: "second-observer", enabled: false, model: "-", runs: 0, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("weird[name]");
    expect(lines[1]).toContain("second-observer");
  });

  it("singularizes run/failure counts of exactly 1", () => {
    const out = formatObserverStatus([
      { name: "solo", enabled: true, model: "m", runs: 1, failures: 1, disabled: false, accepted: 0, dropped: 0 },
    ]);
    expect(out).toMatch(/\b1 run\b/);
    expect(out).not.toMatch(/\b1 runs\b/);
    expect(out).toMatch(/\b1 failure\b/);
    expect(out).not.toMatch(/\b1 failures\b/);
  });
});

describe("readGoal — path exists but is unreadable", () => {
  it("returns undefined without throwing when a directory sits at the goal path", () => {
    // Exercises the try/catch directly, bypassing writeGoal entirely: existsSync sees
    // something at the path, then readFileSync throws (EISDIR) reading it as a file.
    // The goal-tracking observer's veto must fail open here, never throw and wedge a turn.
    mkdirSync(goalFilePath(cwd), { recursive: true });
    expect(() => readGoal(cwd)).not.toThrow();
    expect(readGoal(cwd)).toBeUndefined();
  });
});

describe("writeGoal — ordinary overwrite does not delete first", () => {
  it("keeps the same inode across two writes to an existing goal file", () => {
    // The pre-emptive rmSync+recreate strategy is only for the directory-recovery path.
    // An ordinary overwrite of an existing goal file must truncate-and-rewrite in place
    // (same inode), not unlink-then-recreate (new inode) -- the latter loses atomicity:
    // a crash between the unlink and the write would lose an existing goal outright.
    writeGoal(cwd, "First");
    const inoBefore = statSync(goalFilePath(cwd)).ino;
    writeGoal(cwd, "Second, and longer than the first");
    const inoAfter = statSync(goalFilePath(cwd)).ino;
    expect(inoAfter).toBe(inoBefore);
    expect(readGoal(cwd)).toBe("Second, and longer than the first");
  });
});

describe("formatObserverStatus — failure gating", () => {
  it("does not report zero failures for a healthy, non-disabled observer", () => {
    const out = formatObserverStatus([
      { name: "healthy", enabled: true, model: "m", runs: 5, failures: 0, disabled: false, accepted: 2, dropped: 0 },
    ]);
    expect(out).not.toMatch(/0 failures?/);
  });

  it("does not double-report a disabled observer's failure count", () => {
    // The count already appears once in the state label ("disabled after 3 failures");
    // it must not also appear a second time in the trailing parts list.
    const out = formatObserverStatus([
      { name: "flaky", enabled: true, model: "m", runs: 3, failures: 3, disabled: true, accepted: 0, dropped: 0 },
    ]);
    const occurrences = out.match(/3 failures?/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});

describe("formatObserverStatus — row forgery via name/model", () => {
  // Observer `name` and `model` are copied out of the `name:`/`model:` frontmatter
  // fields of `.pi/observers/*.md` with nothing more than a `.trim()`
  // (src/definitions.ts). Those files are project-scoped repo content, which this
  // project already treats as attacker-influenceable (see src/slices.ts). Every
  // codepoint some renderer could treat as a line break must therefore be collapsed,
  // or a malicious name could inject an extra apparent row -- or forge one outright.
  const SEPARATORS: Record<string, string> = {
    CR: "\r",
    LF: "\n",
    CRLF: "\r\n",
    NEL: "\u0085",
    VT: "\u000B",
    FF: "\u000C",
    LS: "\u2028",
    PS: "\u2029",
  };

  for (const [label, sep] of Object.entries(SEPARATORS)) {
    it(`collapses a ${label} inside a name so N rows always produce N lines`, () => {
      const forgedName = `evil${sep}forged-row [disabled after 99 failures] fake-model`;
      const out = formatObserverStatus([
        { name: forgedName, enabled: true, model: "m", runs: 1, failures: 0, disabled: false, accepted: 0, dropped: 0 },
        { name: "second-observer", enabled: false, model: "-", runs: 0, failures: 0, disabled: false, accepted: 0, dropped: 0 },
      ]);
      expect(out.split("\n")).toHaveLength(2);
      // `.split("\n")` alone only catches LF/CRLF — a raw CR, NEL, VT, FF, LS, or PS
      // left in the output doesn't change that count, but a terminal or markdown
      // renderer can still treat it as a break. Assert the raw separator is gone
      // too, not just that counting by "\n" happens to still work out. Skip this
      // for bare LF: a single "\n" legitimately remains in the output as the
      // between-rows join, so its mere presence there is not a leak of the
      // separator that was inside the name.
      if (label !== "LF") {
        expect(out).not.toContain(sep);
      }
    });
  }

  it("caps an extremely long name so one row cannot dominate the output", () => {
    const out = formatObserverStatus([
      { name: "x".repeat(10_000), enabled: true, model: "m", runs: 1, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(300);
  });
});

describe("formatObserverStatus — row forgery via model (R2-1)", () => {
  // R2-1: removing sanitizeRowField() from row.model alone must fail a test.
  // The name-only tests above don't exercise this at all -- model is a
  // separate call site in the implementation and needs its own coverage.
  it("collapses a NEL inside a model so N rows always produce N lines", () => {
    const forgedModel = "evil" + "\u0085" + "forged-row [disabled after 99 failures] fake-name";
    const out = formatObserverStatus([
      { name: "n1", enabled: true, model: forgedModel, runs: 1, failures: 0, disabled: false, accepted: 0, dropped: 0 },
      { name: "n2", enabled: false, model: "-", runs: 0, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).not.toContain("\u0085");
  });

  it("caps an extremely long model so one row cannot dominate the output", () => {
    const out = formatObserverStatus([
      { name: "n", enabled: true, model: "x".repeat(10_000), runs: 1, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(300);
  });
});

describe("formatObserverStatus — truncation is code-point safe (R2-2)", () => {
  // Mirrors test/slices.test.ts's surrogate-safety pattern: an astral character
  // (U+1F600 GRINNING FACE), written as its surrogate pair in escapes only, is never
  // typed as a literal character in this source file.
  const EMOJI = "\uD83D\uDE00";
  const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const CAP = 200; // MAX_ROW_FIELD_LENGTH in src/commands.ts -- kept in sync by this test

  it.each([CAP - 1, CAP, CAP + 1, CAP + 50])(
    "never splits a surrogate pair when the name lands the emoji at/around the cap (pad=%i)",
    (pad) => {
      const name = "z".repeat(pad) + EMOJI;
      const out = formatObserverStatus([
        { name, enabled: true, model: "m", runs: 1, failures: 0, disabled: false, accepted: 0, dropped: 0 },
      ]);
      expect(LONE_HIGH_SURROGATE.test(out)).toBe(false);
      expect(LONE_LOW_SURROGATE.test(out)).toBe(false);
    },
  );

  it("keeps a whole trailing emoji that fits exactly at the cap, rather than splitting it", () => {
    const name = "z".repeat(CAP - 1) + EMOJI;
    const out = formatObserverStatus([
      { name, enabled: true, model: "m", runs: 1, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    expect(out).toContain(EMOJI);
  });
});
