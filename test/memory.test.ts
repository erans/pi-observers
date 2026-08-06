import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deriveDescription, deriveSlug, writeMemoryNote } from "../src/memory.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-observers-mem-"));
});

describe("deriveSlug", () => {
  it("kebab-cases the first six words", () => {
    expect(deriveSlug("The build uses Vite not Webpack for speed reasons")).toBe(
      "the-build-uses-vite-not-webpack",
    );
  });

  it("strips punctuation and collapses separators", () => {
    expect(deriveSlug("Don't use `sed`; prefer the Edit tool!")).toBe("don-t-use-sed-prefer-the");
  });

  it("falls back to 'note' for text with no usable characters", () => {
    expect(deriveSlug("!!! ???")).toBe("note");
  });
});

describe("deriveDescription", () => {
  it("takes the first sentence", () => {
    expect(deriveDescription("Uses Vite. Not Webpack.")).toBe("Uses Vite.");
  });

  it("truncates past 100 chars", () => {
    const d = deriveDescription("x".repeat(200));
    expect(d.length).toBeLessThanOrEqual(100);
  });
});

describe("writeMemoryNote", () => {
  it("writes a note with frontmatter", () => {
    const { path, slug } = writeMemoryNote({ cwd, text: "The build uses Vite not Webpack" });
    expect(slug).toBe("the-build-uses-vite-not-webpack");
    const content = readFileSync(path, "utf8");
    expect(content).toContain('name: "the-build-uses-vite-not-webpack"');
    expect(content).toContain("type: project");
    expect(content).toContain("The build uses Vite not Webpack");
  });

  it("honours an explicit type", () => {
    const { path } = writeMemoryNote({ cwd, text: "Prefer tabs", type: "feedback" });
    expect(readFileSync(path, "utf8")).toContain("type: feedback");
  });

  it("suffixes on slug collision instead of overwriting", () => {
    const first = writeMemoryNote({ cwd, text: "Same words here now ok yes" });
    const second = writeMemoryNote({ cwd, text: "Same words here now ok yes" });
    expect(second.slug).toBe(`${first.slug}-2`);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  it("creates the memory directory if absent", () => {
    const { path } = writeMemoryNote({ cwd, text: "anything at all here" });
    expect(existsSync(path)).toBe(true);
  });

  it("rejects empty text", () => {
    expect(() => writeMemoryNote({ cwd, text: "   " })).toThrow(/empty/i);
  });

  it("writes frontmatter that actually parses when the text contains YAML syntax", () => {
    // Unquoted, each of these breaks the note: a colon fails to parse, a leading "-"
    // becomes a sequence, and a leading "#" parses as null, silently losing the text.
    for (const text of ["Use Vite: not Webpack", "#1 rule: no bash", "- prefer tabs"]) {
      const { path } = writeMemoryNote({ cwd, text });
      const raw = readFileSync(path, "utf8");
      const fm = parse(raw.split("---")[1] as string);
      expect(typeof fm.description).toBe("string");
      expect(fm.description.length).toBeGreaterThan(0);
    }
  });

  it("writes a name that parses as a string even when the slug is a YAML core-schema keyword", () => {
    // Unquoted, these slugs don't fail to parse — they parse as the WRONG TYPE: "true"/
    // "false" become booleans, "null" becomes null, and an all-digit slug becomes a
    // number. Asserting typeof (not just the value) is essential: a bare
    // `expect(fm.name).toBe("true")` passes whether fm.name is the string "true" or the
    // boolean true, since `toBe` on those isn't what distinguishes them from a bug here —
    // only an explicit typeof check does.
    // "Yes"/"No" are included per the brief's list but are not actually reachable as a
    // type-confusion here: this project's `yaml` (v2, core schema per YAML 1.2) parses
    // "yes"/"no" as plain strings, not booleans (that's YAML 1.1 behaviour). They're kept
    // as regression coverage in case the schema ever changes.
    for (const text of ["True", "False", "Null", "42", "1e10", "Yes", "No"]) {
      const { path, slug } = writeMemoryNote({ cwd, text });
      const raw = readFileSync(path, "utf8");
      const fm = parse(raw.split("---")[1] as string);
      expect(typeof fm.name).toBe("string");
      expect(fm.name).toBe(slug);
    }
  });

  it("falls back to project for an unrecognised type", () => {
    const { path } = writeMemoryNote({ cwd, text: "some note here", type: "bogus\ninjected: yes" });
    const fm = parse(readFileSync(path, "utf8").split("---")[1] as string);
    expect(fm.type).toBe("project");
    expect(fm.injected).toBeUndefined();
  });
});

describe("deriveSlug — non-Latin", () => {
  it("keeps non-Latin words instead of collapsing to the fallback", () => {
    // An [a-z0-9] class would reduce every one of these to "note", so a user writing
    // in Hebrew or Chinese would get note, note-2, note-3 with no descriptive filename.
    expect(deriveSlug("הערה בעברית")).not.toBe("note");
    expect(deriveSlug("中文笔记")).not.toBe("note");
    expect(deriveSlug("café déjà vu")).toBe("café-déjà-vu");
  });
});

describe("deriveDescription — truncation safety", () => {
  it("does not split a surrogate pair at the cap", () => {
    const d = deriveDescription("x".repeat(98) + "\u{1F600}" + "y".repeat(50));
    expect(d).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(d).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

// --- Exploratory tests beyond the brief ---------------------------------------------
//
// The brief's own tests were written by the same person who wrote the implementation,
// so they share whatever blind spots that person had. These probe the specific edge
// cases called out as historically dangerous in this project: a first sentence too big
// to fit, punctuation-only input, double-digit slug collisions, a `type` that almost
// but doesn't quite match a valid value, a body line that collides with the frontmatter
// delimiter, an unwritable filename, and rapid repeated writes.

describe("deriveDescription — an enormous first sentence", () => {
  it("still truncates to the cap even when the match (not just the fallback) is huge", () => {
    // Distinct from the brief's "truncates past 100 chars" test: that text has NO
    // punctuation, so `sentence` comes from the fallback branch (sentence === trimmed).
    // This text has a period, so `sentence` comes from the regex match branch instead —
    // a different code path reaching the same truncation call.
    const text = `${"a".repeat(500)}. Second sentence follows.`;
    const d = deriveDescription(text);
    expect(d.length).toBeLessThanOrEqual(100);
    expect(d.startsWith("a".repeat(50))).toBe(true);
    expect(d.endsWith("…")).toBe(true);
  });
});

describe("deriveDescription — punctuation-only text", () => {
  it("never returns an empty string for pure punctuation", () => {
    // A mutant that made the sentence regex swallow everything into an empty capture,
    // or that let `trim()` reduce this to "", would slip past the brief's tests (which
    // never call deriveDescription on punctuation) but not this one.
    const d = deriveDescription("!!! ??? ...");
    expect(d.length).toBeGreaterThan(0);
  });

  it("produces a note whose frontmatter description is still a non-empty parseable string", () => {
    const { path } = writeMemoryNote({ cwd, text: "!!! ??? ..." });
    const fm = parse(readFileSync(path, "utf8").split("---")[1] as string);
    expect(typeof fm.description).toBe("string");
    expect(fm.description.length).toBeGreaterThan(0);
  });
});

describe("writeMemoryNote — collisions past nine", () => {
  it("keeps incrementing correctly through the two-digit boundary", () => {
    const text = "Same words here now ok yes";
    const base = deriveSlug(text);
    const results = Array.from({ length: 12 }, () => writeMemoryNote({ cwd, text }));
    const slugs = results.map((r) => r.slug);
    // All twelve must be distinct files, not silently deduped or overwritten.
    expect(new Set(slugs).size).toBe(12);
    expect(slugs[0]).toBe(base);
    expect(slugs[8]).toBe(`${base}-9`);
    expect(slugs[9]).toBe(`${base}-10`);
    expect(slugs[10]).toBe(`${base}-11`);
    expect(slugs[11]).toBe(`${base}-12`);
    for (const r of results) expect(existsSync(r.path)).toBe(true);
  });
});

describe("writeMemoryNote — type that almost matches", () => {
  it("rejects a type with a trailing newline rather than treating it as valid", () => {
    // "feedback\n" !== "feedback": a mutant using a substring/startsWith check instead
    // of exact equality would accept this and could let YAML-breaking content through.
    const { path } = writeMemoryNote({ cwd, text: "note text here", type: "feedback\n" });
    const fm = parse(readFileSync(path, "utf8").split("---")[1] as string);
    expect(fm.type).toBe("project");
  });

  it("still accepts a type that is exactly a valid vocabulary word", () => {
    // Paired with the test above: proves the fallback isn't firing unconditionally.
    const { path } = writeMemoryNote({ cwd, text: "note text here", type: "reference" });
    const fm = parse(readFileSync(path, "utf8").split("---")[1] as string);
    expect(fm.type).toBe("reference");
  });
});

describe("writeMemoryNote — body line equal to the frontmatter delimiter", () => {
  it("does not let a literal '---' line in the note text confuse the frontmatter boundary", () => {
    const text = "Rule one\n---\nRule two applies after the divider";
    const { path } = writeMemoryNote({ cwd, text });
    const raw = readFileSync(path, "utf8");

    // Use the same production frontmatter parser this codebase already uses
    // (definitions.ts) rather than a naive split("---"), which a "---" line in the
    // body — or even a "---" substring inside the quoted description — could confuse.
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
    expect(typeof frontmatter.name).toBe("string");
    expect(typeof frontmatter.description).toBe("string");

    // The full original text — including its own "---" line — must survive verbatim
    // in the body, past the frontmatter's closing delimiter.
    expect(body?.trim()).toBe(text);
  });
});

describe("deriveSlug — filename-length safety", () => {
  it("caps a single very long unbroken word so the resulting filename is writable", () => {
    // Six "words" doesn't bound total length when the input has no internal
    // punctuation: a 300-character run of letters is one "word". Before this was
    // capped, writeMemoryNote threw ENAMETOOLONG for input like this.
    const text = "x".repeat(300);
    const slug = deriveSlug(text);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(() => writeMemoryNote({ cwd, text })).not.toThrow();
  });

  it("caps a long run of many short words the same way", () => {
    const text = Array.from({ length: 6 }, () => "supercalifragilisticexpialidocious").join(" ");
    const { path } = writeMemoryNote({ cwd, text });
    expect(existsSync(path)).toBe(true);
  });
});

describe("writeMemoryNote — rapid repeated writes", () => {
  it("gives every write in a tight loop its own file, even with varied whitespace", () => {
    // Not true concurrency (writeMemoryNote is synchronous), but this exercises the
    // same exists-check-then-write loop under rapid repetition, including inputs that
    // normalize to the same slug via different original text.
    const variants = [
      "Same words here now ok yes",
      "  Same   words here now ok yes  ",
      "SAME WORDS HERE NOW OK YES",
      "Same words here now ok yes.",
    ];
    const results = variants.map((text) => writeMemoryNote({ cwd, text }));
    const slugs = results.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(variants.length);
    for (const r of results) expect(existsSync(r.path)).toBe(true);
  });
});
