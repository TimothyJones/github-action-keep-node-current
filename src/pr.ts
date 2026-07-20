import type { getOctokit } from "@actions/github";
import type { CommitGroup } from "./reconcile.js";

export type Octokit = ReturnType<typeof getOctokit>;

export interface PrOptions {
  owner: string;
  repo: string;
  base: string;
  branch: string;
  title: string;
  body: string;
}

export interface PrResult {
  url: string;
  number: number;
}

/** Create the PR, or update the existing open one from the same head branch. */
export async function upsertPullRequest(
  octokit: Octokit,
  opts: PrOptions,
): Promise<PrResult> {
  const head = `${opts.owner}:${opts.branch}`;

  const existing = await octokit.rest.pulls.list({
    owner: opts.owner,
    repo: opts.repo,
    head,
    base: opts.base,
    state: "open",
  });

  if (existing.data.length > 0) {
    const pr = existing.data[0];
    await octokit.rest.pulls.update({
      owner: opts.owner,
      repo: opts.repo,
      pull_number: pr.number,
      title: opts.title,
      body: opts.body,
    });
    return { url: pr.html_url, number: pr.number };
  }

  const created = await octokit.rest.pulls.create({
    owner: opts.owner,
    repo: opts.repo,
    base: opts.base,
    head: opts.branch,
    title: opts.title,
    body: opts.body,
  });
  return { url: created.data.html_url, number: created.data.number };
}

/** Build the PR description from the commit groups and the schedule source. */
export function buildPrBody(
  groups: CommitGroup[],
  scheduleUrl: string,
): string {
  const lines: string[] = [];
  lines.push(
    "Automated sync of Node.js versions against the official release schedule.",
  );
  lines.push("");

  const adds = groups.filter((g) => g.kind === "add");
  const drops = groups.filter((g) => g.kind === "drop");

  if (adds.length) {
    lines.push("### Added");
    for (const g of adds) lines.push(`- Node ${g.major}`);
    lines.push("");
  }
  if (drops.length) {
    lines.push("### Dropped");
    for (const g of drops) lines.push(`- Node ${g.major}`);
    lines.push("");
  }

  lines.push(`Source: ${scheduleUrl}`);
  return lines.join("\n");
}
