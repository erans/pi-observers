import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { ObserverDefinitionError, parseObserverDefinition } from "./definitions.ts";
import type { ObserverDefinition, ObserverScope } from "./types.ts";

export interface DiscoveryOptions {
  cwd: string;
  agentDir: string;
  builtinDir: string;
  /**
   * Whether the checked-out project is trusted. Required, not optional with a default:
   * the safe value is `false`, and an optional flag defaulting to `true` is how a gate
   * gets silently skipped by a caller that predates it.
   */
  projectTrusted: boolean;
}

export interface DiscoveryResult {
  observers: ObserverDefinition[];
  errors: ObserverDefinitionError[];
}

/** Whether a directory holds at least one file this module would try to parse. */
function hasDefinitions(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => entry.endsWith(".md"));
  } catch {
    return false;
  }
}

function loadDir(dir: string, scope: ObserverScope, errors: ObserverDefinitionError[]) {
  const found: ObserverDefinition[] = [];

  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) {
      errors.push(new ObserverDefinitionError("expected a directory of observer definitions", dir));
      return found;
    }
    entries = readdirSync(dir);
  } catch (error) {
    // A layer that does not exist is the ordinary case and is not an error -- most
    // projects have no .pi/observers at all. Anything else (a permission error, an I/O
    // error, a path that is a file) silently produced zero observers AND zero errors,
    // so the extension reported "No observers loaded." with no way to tell that from a
    // directory full of definitions the process could not read. A per-FILE failure has
    // always landed in `errors`; a whole-directory failure did not.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      errors.push(
        new ObserverDefinitionError(`observer directory is unreadable: ${String(error)}`, dir),
      );
    }
    return found;
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      found.push(parseObserverDefinition(readFileSync(path, "utf8"), path, scope));
    } catch (error) {
      errors.push(
        error instanceof ObserverDefinitionError
          ? error
          : new ObserverDefinitionError(String(error), path),
      );
    }
  }
  return found;
}

/**
 * Discover observer definitions across all three scopes.
 *
 * Precedence is project > user > builtin, keyed on the `name` field rather than
 * the filename, so an override does not have to reuse the shipped filename.
 * Overriding one observer never disturbs the others.
 */
export function discoverObservers(opts: DiscoveryOptions): DiscoveryResult {
  const errors: ObserverDefinitionError[] = [];

  const layers: Array<[string, ObserverScope]> = [
    [opts.builtinDir, "builtin"],
    [join(opts.agentDir, "observers"), "user"],
  ];

  // The design spec makes this conditional: ".pi/observers/*.md -- project (loaded only
  // after project trust)". It was not implemented, while the settings block ten lines
  // away in src/index.ts was already gated on ctx.isProjectTrusted().
  //
  // The output caps elsewhere are not a substitute and no further cap would be. A
  // project definition is not data this extension renders -- it RUNS, as an agent on the
  // user's credentials, at a trigger the file chooses (`on: tool_execution_end`), for a
  // timeout the file chooses (`timeout_ms` has no upper bound), reading anything the
  // process can read and spending tokens without limit. Precedence keys on `name`, so an
  // untrusted file also replaces a shipped observer wholesale.
  const projectDir = join(opts.cwd, CONFIG_DIR_NAME, "observers");
  if (opts.projectTrusted) {
    layers.push([projectDir, "project"]);
  } else if (hasDefinitions(projectDir)) {
    // Only when something would actually have loaded. Warning about an empty directory,
    // or one holding nothing but a README, contradicts the reason this stays silent when
    // the directory is absent: a warning about nothing teaches the user to ignore the
    // warning that matters. Routed through `errors` so the surfaces in src/index.ts pick
    // it up unchanged.
    errors.push(
      new ObserverDefinitionError(
        "project observers were not loaded because this project is not trusted; trust the project to enable them",
        projectDir,
      ),
    );
  }

  const byName = new Map<string, ObserverDefinition>();
  for (const [dir, scope] of layers) {
    for (const definition of loadDir(dir, scope, errors)) {
      // Shadowing ACROSS layers is the documented precedence rule. Shadowing WITHIN one
      // layer is two files claiming the same `name`, resolved silently by whichever
      // filename sorts later -- so the observer a user edits may not be the one that
      // runs, and nothing says so.
      const prior = byName.get(definition.name);
      if (prior !== undefined && prior.scope === scope) {
        errors.push(
          new ObserverDefinitionError(
            `duplicate observer name "${definition.name}" in the ${scope} layer; "${prior.sourcePath}" is ignored in favour of this file`,
            definition.sourcePath,
          ),
        );
      }
      byName.set(definition.name, definition);
    }
  }

  return { observers: [...byName.values()], errors };
}
