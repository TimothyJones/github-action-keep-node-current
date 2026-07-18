import { writeFile } from "node:fs/promises";
import * as exec from "@actions/exec";
import type { ReconcileResult } from "./core.js";

export interface GitOptions {
  cwd: string;
  branch: string;
  base: string;
  owner: string;
  repo: string;
  token: string;
  userName: string;
  userEmail: string;
  /** Override the push remote URL (defaults to the token-authenticated GitHub URL). Used by tests. */
  remoteUrl?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const out = await exec.getExecOutput("git", args, {
    cwd,
    silent: true,
    ignoreReturnCode: true,
  });
  if (out.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${out.exitCode}): ${out.stderr.trim() || out.stdout.trim()}`,
    );
  }
  return out.stdout.trim();
}

/**
 * Commit each group as its own commit on a fresh working branch, then force-push.
 * Edits are applied to an in-memory content map and written to disk incrementally
 * so each commit contains only that version's changes.
 */
export async function commitAndPush(
  result: ReconcileResult,
  opts: GitOptions,
): Promise<void> {
  await git(opts.cwd, ["config", "user.name", opts.userName]);
  await git(opts.cwd, ["config", "user.email", opts.userEmail]);

  if (opts.remoteUrl) {
    // Tests push to a local remote (e.g. a bare repo) with no auth needed.
    await git(opts.cwd, ["remote", "set-url", "origin", opts.remoteUrl]);
  } else {
    // Authenticate as the provided token. actions/checkout persists the workflow's
    // GITHUB_TOKEN as an http.extraheader, and that header takes precedence over any
    // credentials embedded in the remote URL. Since the GITHUB_TOKEN cannot modify
    // workflow files, we must replace that header with the supplied (workflow-scoped)
    // token so pushes to .github/workflows/ are accepted.
    const auth = Buffer.from(`x-access-token:${opts.token}`).toString("base64");
    await git(opts.cwd, [
      "config",
      "--local",
      "--replace-all",
      "http.https://github.com/.extraheader",
      `AUTHORIZATION: basic ${auth}`,
    ]);
  }

  // Create the working branch at the current checkout (the base ref the workflow ran on).
  // Branching from HEAD avoids relying on an `origin/<base>` tracking ref, which
  // actions/checkout does not create for shallow single-ref clones.
  await git(opts.cwd, ["checkout", "-B", opts.branch]);

  const contents = new Map(result.originals);
  for (const group of result.groups) {
    for (const plan of group.plans) {
      const current = contents.get(plan.path) ?? "";
      const updated = plan.apply(current, {
        kind: group.kind,
        major: group.major,
      });
      contents.set(plan.path, updated);
      await writeFile(plan.path, updated, "utf8");
      await git(opts.cwd, ["add", plan.path]);
    }
    // Defensive: never fail the run on an empty commit if a group staged no net change.
    const staged = await exec.getExecOutput(
      "git",
      ["diff", "--cached", "--quiet"],
      {
        cwd: opts.cwd,
        silent: true,
        ignoreReturnCode: true,
      },
    );
    if (staged.exitCode !== 0) {
      await git(opts.cwd, ["commit", "-m", group.message]);
    }
  }

  await git(opts.cwd, ["push", "--force", "origin", opts.branch]);
}
