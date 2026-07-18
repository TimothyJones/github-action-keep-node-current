import { parseVersionLiteral } from "./format.js";
import type { Editor, FilePlan, VersionChange } from "./reconcile.js";
import type { Schedule } from "./schedule.js";

/**
 * `.nvmrc` holds a single Node version (optionally `v`-prefixed). It is a
 * single-version pin: left alone while its major is active, and bumped to the
 * newest even active major once it falls out of support.
 */
function read(
  content: string,
): { prefix: string; major: number; newline: string } | undefined {
  const newline = content.endsWith("\n") ? "\n" : "";
  const trimmed = content.trim();
  const match = /^(v?)(.+)$/.exec(trimmed);
  if (!match) return undefined;
  const parsed = parseVersionLiteral(match[2]);
  if (!parsed) return undefined; // lts/*, codenames, etc. — leave untouched
  return { prefix: match[1], major: parsed.major, newline };
}

export const nvmrcEditor: Editor = {
  plan(path: string, content: string, schedule: Schedule): FilePlan | null {
    const info = read(content);
    if (!info) return null;
    if (schedule.isActive(info.major)) return null;
    if (schedule.newestEven === undefined) return null;

    const change: VersionChange = { kind: "drop", major: info.major };
    return {
      path,
      changes: [change],
      apply(current: string, applied: VersionChange): string {
        const cur = read(current);
        if (!cur || applied.kind !== "drop" || cur.major !== applied.major)
          return current;
        if (schedule.newestEven === undefined) return current;
        return `${cur.prefix}${schedule.newestEven}${cur.newline}`;
      },
    };
  },
};
