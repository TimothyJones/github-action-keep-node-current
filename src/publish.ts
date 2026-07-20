import { relative, sep } from "node:path";
import type { ReconcileResult } from "./core.js";
import { upsertPullRequest, type Octokit, type PrResult } from "./pr.js";

// Commits are attributed to the GitHub Actions bot rather than the token owner.
const AUTHOR = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

export interface PublishOptions {
  owner: string;
  repo: string;
  base: string;
  branch: string;
  /** Absolute repo root; plan paths are made relative to it for the Git API. */
  root: string;
  title: string;
  body: string;
}

export interface PublishResult extends PrResult {
  commits: number;
}

/** Convert an absolute plan path into a POSIX repo-relative path for the Git tree API. */
function repoPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

/**
 * Publish the reconciled changes entirely through the GitHub Git Data API: build one
 * commit per version change on top of the base branch, point the working branch at the
 * result, and open/update the PR. No local git or credential handling is involved, so
 * this is immune to how actions/checkout persists credentials.
 */
export async function publishChanges(
  octokit: Octokit,
  result: ReconcileResult,
  opts: PublishOptions,
): Promise<PublishResult | null> {
  const { owner, repo, base, branch, root } = opts;

  const baseRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  let parentCommit = baseRef.data.object.sha;
  const baseCommit = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: parentCommit,
  });
  let parentTree = baseCommit.data.tree.sha;

  const contents = new Map(result.originals);
  let commits = 0;

  for (const group of result.groups) {
    const entries: Array<{
      path: string;
      mode: "100644";
      type: "blob";
      content: string;
    }> = [];
    for (const plan of group.plans) {
      const current = contents.get(plan.path) ?? "";
      const updated = plan.apply(current, {
        kind: group.kind,
        major: group.major,
      });
      if (updated !== current) {
        contents.set(plan.path, updated);
        entries.push({
          path: repoPath(root, plan.path),
          mode: "100644",
          type: "blob",
          content: updated,
        });
      }
    }
    // Skip groups whose edits produced no net change (e.g. the add paired with a pin
    // bump already applied by its drop) rather than creating an empty commit.
    if (entries.length === 0) continue;

    const tree = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: parentTree,
      tree: entries,
    });
    const commit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: group.message,
      tree: tree.data.sha,
      parents: [parentCommit],
      author: AUTHOR,
      committer: AUTHOR,
    });
    parentCommit = commit.data.sha;
    parentTree = tree.data.sha;
    commits++;
  }

  if (commits === 0) return null;

  // Point the working branch at the new commit, creating it if it does not exist.
  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: parentCommit,
      force: true,
    });
  } catch {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: parentCommit,
    });
  }

  const pr = await upsertPullRequest(octokit, {
    owner,
    repo,
    base,
    branch,
    title: opts.title,
    body: opts.body,
  });
  return { ...pr, commits };
}
