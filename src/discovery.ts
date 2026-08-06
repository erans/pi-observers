import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { ObserverDefinitionError, parseObserverDefinition } from "./definitions.ts";
import type { ObserverDefinition, ObserverScope } from "./types.ts";

export interface DiscoveryOptions {
  cwd: string;
  agentDir: string;
  builtinDir: string;
}

export interface DiscoveryResult {
  observers: ObserverDefinition[];
  errors: ObserverDefinitionError[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function loadDir(dir: string, scope: ObserverScope, errors: ObserverDefinitionError[]) {
  const found: ObserverDefinition[] = [];
  if (!isDirectory(dir)) return found;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
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
    [join(opts.cwd, CONFIG_DIR_NAME, "observers"), "project"],
  ];

  const byName = new Map<string, ObserverDefinition>();
  for (const [dir, scope] of layers) {
    for (const definition of loadDir(dir, scope, errors)) {
      byName.set(definition.name, definition);
    }
  }

  return { observers: [...byName.values()], errors };
}
