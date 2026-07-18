import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** In-scope files, grouped by which editor handles them. Paths are absolute. */
export interface Discovered {
  workflows: string[];
  nvmrc: string[];
  packageJson: string[];
}

function isYaml(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

async function listDir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(dir, e.name));
}

/** Recursively find every action.yml/action.yaml under `.github/actions`. */
async function findCompositeActions(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findCompositeActions(full)));
    } else if (entry.name === "action.yml" || entry.name === "action.yaml") {
      found.push(full);
    }
  }
  return found;
}

/**
 * Discover the files to reconcile in the repository rooted at `root`:
 * workflow YAML, composite action definitions, .nvmrc, and the root package.json.
 */
export async function discover(root: string): Promise<Discovered> {
  const workflowFiles = (
    await listDir(join(root, ".github", "workflows"))
  ).filter((p) => isYaml(p));
  const compositeActions = await findCompositeActions(
    join(root, ".github", "actions"),
  );

  const nvmrc = join(root, ".nvmrc");
  const packageJson = join(root, "package.json");

  return {
    workflows: [...workflowFiles, ...compositeActions],
    nvmrc: existsSync(nvmrc) ? [nvmrc] : [],
    packageJson: existsSync(packageJson) ? [packageJson] : [],
  };
}

/** Classify explicit path overrides (from the `paths` input) into the same groups. */
export function classifyOverrides(paths: string[]): Discovered {
  const result: Discovered = { workflows: [], nvmrc: [], packageJson: [] };
  for (const p of paths) {
    const base = p.split(/[/\\]/).pop() ?? p;
    if (base === ".nvmrc") result.nvmrc.push(p);
    else if (base === "package.json") result.packageJson.push(p);
    else if (isYaml(base)) result.workflows.push(p);
  }
  return result;
}
