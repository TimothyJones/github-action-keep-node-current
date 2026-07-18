import { parseVersionLiteral } from "./format.js";
import type { Editor, FilePlan, VersionChange } from "./reconcile.js";
import type { Schedule } from "./schedule.js";

/**
 * The smallest major mentioned anywhere in an `engines.node` range — a good
 * enough approximation of the effective floor for the ranges seen in practice
 * (`>=18`, `^20`, `18 || 20 || 22`, `>=18 <21`, `20.x`, ...). Returns undefined
 * when the range mentions no concrete version (`*`, `latest`).
 */
function floorMajor(range: string): number | undefined {
  const tokens = range.match(/\d+(?:\.\d+)*(?:\.x)?/g);
  if (!tokens) return undefined;
  let min: number | undefined;
  for (const token of tokens) {
    const parsed = parseVersionLiteral(token);
    if (parsed && (min === undefined || parsed.major < min)) min = parsed.major;
  }
  return min;
}

/** Read `engines.node` from a package.json string without disturbing its formatting. */
function readEnginesNode(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const engines = (parsed as { engines?: unknown }).engines;
  if (!engines || typeof engines !== "object") return undefined;
  const node = (engines as { node?: unknown }).node;
  return typeof node === "string" ? node : undefined;
}

// Rewrites the string value of engines.node in place, preserving surrounding formatting.
const ENGINES_NODE = /("engines"\s*:\s*\{[^{}]*?"node"\s*:\s*")([^"]*)(")/;

export const packageJsonEditor: Editor = {
  plan(path: string, content: string, schedule: Schedule): FilePlan | null {
    const current = readEnginesNode(content);
    if (current === undefined) return null; // absent engines.node -> leave as-is

    const floor = floorMajor(current);
    if (floor === undefined) return null;
    if (schedule.lowestEven === undefined) return null;
    // Already at or above the lowest active even major (e.g. ">=20.19" when lowest is 20): leave it.
    if (floor >= schedule.lowestEven) return null;

    const change: VersionChange = { kind: "drop", major: floor };
    return {
      path,
      changes: [change],
      apply(currentContent: string, applied: VersionChange): string {
        if (applied.kind !== "drop") return currentContent;
        if (schedule.lowestEven === undefined) return currentContent;
        const target = `>=${schedule.lowestEven}.0.0`;
        return currentContent.replace(
          ENGINES_NODE,
          (_m, pre, _val, post) => `${pre}${target}${post}`,
        );
      },
    };
  },
};
