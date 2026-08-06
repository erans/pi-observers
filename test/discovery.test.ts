import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
    const { observers, errors } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(errors).toEqual([]);
    expect(observers.map((o) => o.name)).toEqual(["a"]);
    expect(observers[0]?.scope).toBe("builtin");
  });

  it("lets user override builtin, and project override user", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    writeFileSync(join(agentDir, "observers", "a.md"), def("a", "user a"));
    const userWins = discoverObservers({ cwd, agentDir, builtinDir });
    expect(userWins.observers[0]?.description).toBe("user a");
    expect(userWins.observers[0]?.scope).toBe("user");

    writeFileSync(join(cwd, ".pi", "observers", "a.md"), def("a", "project a"));
    const projectWins = discoverObservers({ cwd, agentDir, builtinDir });
    expect(projectWins.observers[0]?.description).toBe("project a");
    expect(projectWins.observers[0]?.scope).toBe("project");
  });

  it("overriding one observer leaves the others alone", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    writeFileSync(join(builtinDir, "b.md"), def("b", "builtin b"));
    writeFileSync(join(agentDir, "observers", "a.md"), def("a", "user a"));
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir });
    const byName = Object.fromEntries(observers.map((o) => [o.name, o.description]));
    expect(byName).toEqual({ a: "user a", b: "builtin b" });
  });

  it("matches on the name field, not the filename", () => {
    writeFileSync(join(builtinDir, "a.md"), def("shared", "builtin"));
    writeFileSync(join(agentDir, "observers", "totally-different.md"), def("shared", "user"));
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.description).toBe("user");
  });

  it("collects a bad file as an error and still loads the good ones", () => {
    writeFileSync(join(builtinDir, "good.md"), def("good", "fine"));
    writeFileSync(join(builtinDir, "bad.md"), `---\nname: bad\n---\nno description or trigger`);
    const { observers, errors } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(observers.map((o) => o.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toContain("bad.md");
  });

  it("returns empty when no directories exist", () => {
    const result = discoverObservers({
      cwd: join(root, "nope"),
      agentDir: join(root, "nope"),
      builtinDir: join(root, "nope"),
    });
    expect(result.observers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("ignores non-markdown files", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "yes"));
    writeFileSync(join(builtinDir, "notes.txt"), "ignore me");
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(observers).toHaveLength(1);
  });
});
