import type { Schedule } from "./schedule.js";

export type ChangeKind = "add" | "drop";

/** A single version being added or dropped somewhere. */
export interface VersionChange {
  kind: ChangeKind;
  major: number;
}

/**
 * The result of analysing one file: which version changes it participates in,
 * and a pure function that applies exactly one of those changes to a content
 * string. Applying changes one at a time (re-parsing each time) lets the
 * orchestrator produce a separate commit per version.
 */
export interface FilePlan {
  /** Repo-relative path. */
  path: string;
  /** Distinct changes this file needs; empty means the file is already in sync. */
  changes: VersionChange[];
  /** Apply a single change to the given content, returning the new content. Idempotent. */
  apply(content: string, change: VersionChange): string;
}

/** An editor inspects one file's content and returns a plan (or null if the file is irrelevant). */
export interface Editor {
  plan(path: string, content: string, schedule: Schedule): FilePlan | null;
}

/** A per-version commit: the message plus the files whose edits belong to it. */
export interface CommitGroup {
  kind: ChangeKind;
  major: number;
  message: string;
  /** Plans (files) that carry a change for this (kind, major). */
  plans: FilePlan[];
}

const key = (kind: ChangeKind, major: number) => `${kind}:${major}`;

/** Human-facing commit subject for a single version change. */
export function commitMessage(kind: ChangeKind, major: number): string {
  return kind === "add"
    ? `feat: Add support for node version ${major}`
    : `feat!: Drop support for node version ${major}`;
}

/**
 * Group file plans into one commit per (kind, major). Adds are ordered ascending
 * first, then drops ascending — a natural changelog reading and safe because the
 * add-set (active-even majors) and drop-set (inactive majors) are always disjoint.
 */
export function groupCommits(plans: FilePlan[]): CommitGroup[] {
  const groups = new Map<string, CommitGroup>();

  for (const plan of plans) {
    for (const change of plan.changes) {
      const k = key(change.kind, change.major);
      let group = groups.get(k);
      if (!group) {
        group = {
          kind: change.kind,
          major: change.major,
          message: commitMessage(change.kind, change.major),
          plans: [],
        };
        groups.set(k, group);
      }
      if (!group.plans.includes(plan)) group.plans.push(plan);
    }
  }

  const adds = [...groups.values()]
    .filter((g) => g.kind === "add")
    .sort((a, b) => a.major - b.major);
  const drops = [...groups.values()]
    .filter((g) => g.kind === "drop")
    .sort((a, b) => a.major - b.major);
  return [...adds, ...drops];
}

/** The distinct majors added and dropped across all commit groups. */
export function summarize(groups: CommitGroup[]): {
  added: number[];
  removed: number[];
} {
  const added = groups.filter((g) => g.kind === "add").map((g) => g.major);
  const removed = groups.filter((g) => g.kind === "drop").map((g) => g.major);
  return { added, removed };
}

/**
 * Build the composite PR title from the added/dropped majors.
 * - adds only:  `feat: Add support for X, Y`
 * - drops only: `feat!: Drop support for X, Y`
 * - both:       `feat!: Add support for X, drop support for Z`
 * The `!` (breaking) marker appears whenever anything is dropped.
 */
export function prTitle(added: number[], removed: number[]): string {
  const a = [...added].sort((x, y) => x - y);
  const d = [...removed].sort((x, y) => x - y);
  const list = (xs: number[]) => xs.join(", ");

  if (a.length && d.length) {
    return `feat!: Add support for node version ${list(a)}, drop support for node version ${list(d)}`;
  }
  if (d.length) {
    return `feat!: Drop support for node version ${list(d)}`;
  }
  return `feat: Add support for node version ${list(a)}`;
}
