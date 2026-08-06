import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { discoverObservers } from "../src/discovery.ts";

function def(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\non: turn_end\n---\nBody for ${name}.\n`;
}

let root: string;
let builtinDir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-observers-"));
  builtinDir = join(root, "builtin");
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  for (const d of [builtinDir, join(agentDir, "observers"), join(cwd, ".pi", "observers")]) {
    mkdirSync(d, { recursive: true });
  }
});

describe("discoverObservers", () => {
  it("loads builtins when nothing overrides them", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    const { observers, errors } = discoverObservers({
      cwd,
      agentDir,
      builtinDir,
      projectTrusted: true,
    });
    expect(errors).toEqual([]);
    expect(observers.map((o) => o.name)).toEqual(["a"]);
    expect(observers[0]?.scope).toBe("builtin");
  });

  it("lets user override builtin, and project override user", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    writeFileSync(join(agentDir, "observers", "a.md"), def("a", "user a"));
    const userWins = discoverObservers({ cwd, agentDir, builtinDir, projectTrusted: true });
    expect(userWins.observers[0]?.description).toBe("user a");
    expect(userWins.observers[0]?.scope).toBe("user");

    writeFileSync(join(cwd, ".pi", "observers", "a.md"), def("a", "project a"));
    const projectWins = discoverObservers({ cwd, agentDir, builtinDir, projectTrusted: true });
    expect(projectWins.observers[0]?.description).toBe("project a");
    expect(projectWins.observers[0]?.scope).toBe("project");
  });

  it("overriding one observer leaves the others alone", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    writeFileSync(join(builtinDir, "b.md"), def("b", "builtin b"));
    writeFileSync(join(agentDir, "observers", "a.md"), def("a", "user a"));
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir, projectTrusted: true });
    const byName = Object.fromEntries(observers.map((o) => [o.name, o.description]));
    expect(byName).toEqual({ a: "user a", b: "builtin b" });
  });

  it("matches on the name field, not the filename", () => {
    writeFileSync(join(builtinDir, "a.md"), def("shared", "builtin"));
    writeFileSync(join(agentDir, "observers", "totally-different.md"), def("shared", "user"));
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir, projectTrusted: true });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.description).toBe("user");
  });

  it("collects a bad file as an error and still loads the good ones", () => {
    writeFileSync(join(builtinDir, "good.md"), def("good", "fine"));
    writeFileSync(join(builtinDir, "bad.md"), `---\nname: bad\n---\nno description or trigger`);
    const { observers, errors } = discoverObservers({
      cwd,
      agentDir,
      builtinDir,
      projectTrusted: true,
    });
    expect(observers.map((o) => o.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toContain("bad.md");
  });

  it("returns empty when no directories exist", () => {
    const result = discoverObservers({
      cwd: join(root, "nope"),
      agentDir: join(root, "nope"),
      builtinDir: join(root, "nope"),
      projectTrusted: true,
    });
    expect(result.observers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  describe("project trust", () => {
    it("does not load project observers when the project is untrusted", () => {
      writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
      writeFileSync(join(cwd, ".pi", "observers", "evil.md"), def("evil", "runs on the user"));
      const { observers } = discoverObservers({
        cwd,
        agentDir,
        builtinDir,
        projectTrusted: false,
      });
      expect(observers.map((o) => o.name)).toEqual(["a"]);
    });

    it("does not let an untrusted project replace a shipped observer", () => {
      // Precedence keys on `name`, so the gate is not only about ADDING an observer:
      // without it a project file silently becomes the definition of a bundled one.
      writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
      writeFileSync(join(cwd, ".pi", "observers", "a.md"), def("a", "hijacked"));
      const { observers } = discoverObservers({
        cwd,
        agentDir,
        builtinDir,
        projectTrusted: false,
      });
      expect(observers[0]?.description).toBe("builtin a");
      expect(observers[0]?.scope).toBe("builtin");
    });

    it("says so when definitions are present but the layer was skipped", () => {
      // Otherwise the fix is the same defect it replaces: files present, nothing
      // loaded, nothing said.
      writeFileSync(join(cwd, ".pi", "observers", "evil.md"), def("evil", "x"));
      const { errors } = discoverObservers({ cwd, agentDir, builtinDir, projectTrusted: false });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/not trusted/i);
      expect(errors[0]?.file).toContain(join(".pi", "observers"));
    });

    it("stays silent when the project's observers directory holds nothing loadable", () => {
      // Same rationale as the absent-directory case below: a warning about nothing
      // teaches the user to ignore the warning that matters. An empty directory, and one
      // holding only a README, would both have loaded zero observers even if trusted.
      const { errors: emptyDir } = discoverObservers({
        cwd,
        agentDir,
        builtinDir,
        projectTrusted: false,
      });
      expect(emptyDir).toEqual([]);

      writeFileSync(join(cwd, ".pi", "observers", "README.txt"), "notes, not a definition");
      const { errors: noMarkdown } = discoverObservers({
        cwd,
        agentDir,
        builtinDir,
        projectTrusted: false,
      });
      expect(noMarkdown).toEqual([]);
    });

    it("stays silent when the project has no observers directory at all", () => {
      // The common case. A warning here would train the user to ignore the warning.
      const bare = mkdtempSync(join(tmpdir(), "pi-observers-bare-"));
      const { errors } = discoverObservers({
        cwd: bare,
        agentDir,
        builtinDir,
        projectTrusted: false,
      });
      expect(errors).toEqual([]);
    });

    it("still loads user and builtin layers when the project is untrusted", () => {
      writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
      writeFileSync(join(agentDir, "observers", "b.md"), def("b", "user b"));
      const { observers } = discoverObservers({
        cwd,
        agentDir,
        builtinDir,
        projectTrusted: false,
      });
      expect(observers.map((o) => o.name).sort()).toEqual(["a", "b"]);
    });
  });

  describe("directory-level failures", () => {
    // Root ignores directory permissions, so the unreadable case cannot be constructed
    // there. Skipped rather than silently weakened.
    const asUser = process.getuid?.() === 0 ? it.skip : it;

    asUser("reports an unreadable observer directory instead of returning silence", () => {
      // A per-FILE parse failure has always landed in `errors`. A whole-directory
      // failure produced 0 observers and 0 errors, which renders as "No observers
      // loaded." and is indistinguishable from an empty install.
      const locked = join(root, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "a.md"), def("a", "unreachable"));
      chmodSync(locked, 0o000);
      try {
        const { observers, errors } = discoverObservers({
          cwd,
          agentDir,
          builtinDir: locked,
          projectTrusted: true,
        });
        expect(observers).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toMatch(/unreadable/i);
      } finally {
        chmodSync(locked, 0o700);
      }
    });

    it("reports a path that is a file where a directory was expected", () => {
      const notADir = join(root, "not-a-dir");
      writeFileSync(notADir, "this is a file, not a directory");
      const { observers, errors } = discoverObservers({
        cwd,
        agentDir,
        builtinDir: notADir,
        projectTrusted: true,
      });
      expect(observers).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/expected a directory/i);
    });

    it("does not report a directory that simply does not exist", () => {
      const { errors } = discoverObservers({
        cwd,
        agentDir,
        builtinDir: join(root, "absent"),
        projectTrusted: true,
      });
      expect(errors).toEqual([]);
    });
  });

  it("reports two definitions claiming the same name in one layer", () => {
    // Across layers this is the documented override. Within one layer it is two files
    // fighting, resolved by whichever filename sorts later, with no diagnostic at all --
    // so the file a user edits may not be the one that runs.
    writeFileSync(join(builtinDir, "aaa.md"), def("same", "from aaa"));
    writeFileSync(join(builtinDir, "zzz.md"), def("same", "from zzz"));
    const { observers, errors } = discoverObservers({
      cwd,
      agentDir,
      builtinDir,
      projectTrusted: true,
    });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.description).toBe("from zzz");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/duplicate observer name "same"/);
    expect(errors[0]?.message).toContain("aaa.md");
  });

  it("does not report a cross-layer override as a duplicate", () => {
    writeFileSync(join(builtinDir, "a.md"), def("same", "builtin"));
    writeFileSync(join(agentDir, "observers", "a.md"), def("same", "user"));
    const { errors } = discoverObservers({ cwd, agentDir, builtinDir, projectTrusted: true });
    expect(errors).toEqual([]);
  });

  it("ignores non-markdown files", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "yes"));
    writeFileSync(join(builtinDir, "notes.txt"), "ignore me");
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir, projectTrusted: true });
    expect(observers).toHaveLength(1);
  });
});
