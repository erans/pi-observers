import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const MAX_DESCRIPTION = 100;
const SLUG_WORDS = 6;
/** Filenames longer than ~255 bytes throw ENAMETOOLONG on common filesystems. Six
 *  "words" can still blow past that if the input has no punctuation to break on (a
 *  single 300-character run of letters is one "word"), so cap the joined slug too. */
const MAX_SLUG_LENGTH = 80;

/** The note `type` vocabulary from the design doc. An unrecognised value falls back
 *  rather than being written through: `type` reaches here from a `--type` flag, and an
 *  arbitrary string would both break the frontmatter and defeat any later filtering. */
const NOTE_TYPES = ["project", "feedback", "reference", "user"] as const;
const DEFAULT_NOTE_TYPE = "project";

/** Deterministic, no model call: first six words, kebab-cased.
 *  Unicode-aware on purpose. An [a-z0-9] class silently reduces any non-Latin note to
 *  the fallback slug, so every Hebrew or Chinese note would land as note, note-2,
 *  note-3 — losing the descriptive filename that is the whole point of the slug. It
 *  also mangles accented Latin ("café déjà vu" -> "caf-d-j-vu"). */
export function deriveSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, SLUG_WORDS)
    .join("-");
  if (slug === "") return "note";
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  // Truncate by code point, same rationale as deriveDescription: slicing UTF-16 units
  // can cut a surrogate pair in half and emit a lone surrogate.
  const truncated = Array.from(slug).slice(0, MAX_SLUG_LENGTH).join("").replace(/-+$/, "");
  return truncated === "" ? "note" : truncated;
}

/** First sentence, truncated. This is what the recall observer ranks against. */
export function deriveDescription(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const match = trimmed.match(/^.*?[.!?](\s|$)/);
  const sentence = (match ? match[0] : trimmed).trim();
  if (sentence.length <= MAX_DESCRIPTION) return sentence;
  // Truncate by code point: slice() on UTF-16 units can cut a surrogate pair in half
  // and emit a lone surrogate, producing invalid UTF-8 in the written file.
  const cut = Array.from(sentence)
    .slice(0, MAX_DESCRIPTION - 1)
    .join("")
    .trimEnd();
  return `${cut}…`;
}

export function memoryDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "memory");
}

export function writeMemoryNote(opts: { cwd: string; text: string; type?: string }): {
  path: string;
  slug: string;
} {
  const text = opts.text.trim();
  if (text === "") throw new Error("Cannot write an empty memory note.");

  const dir = memoryDir(opts.cwd);
  mkdirSync(dir, { recursive: true });

  const base = deriveSlug(text);
  let slug = base;
  let n = 1;
  while (existsSync(join(dir, `${slug}.md`))) {
    n += 1;
    slug = `${base}-${n}`;
  }

  const path = join(dir, `${slug}.md`);
  const type = NOTE_TYPES.includes(opts.type as (typeof NOTE_TYPES)[number])
    ? (opts.type as string)
    : DEFAULT_NOTE_TYPE;
  // description is arbitrary user text and MUST be quoted. Unquoted, a colon makes the
  // frontmatter fail to parse, a leading "-" turns it into a sequence, and a leading "#"
  // makes the whole value parse as null — silently discarding the description with no
  // error anywhere. JSON.stringify emits a double-quoted scalar that YAML accepts, with
  // quotes and backslashes escaped, and it is fully deterministic.
  const content = `---
name: ${slug}
description: ${JSON.stringify(deriveDescription(text))}
type: ${type}
---

${text}
`;
  writeFileSync(path, content, "utf8");
  return { path, slug };
}
