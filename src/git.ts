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

/** Run git, tolerating a non-zero exit (e.g. `--unset-all` on a missing key). */
async function gitTry(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  const out = await exec.getExecOutput("git", args, {
    cwd,
    silent: true,
    ignoreReturnCode: true,
  });
  return { code: out.exitCode, stdout: out.stdout };
}

/**
 * Authenticate git as the supplied token. actions/checkout persists the workflow's
 * GITHUB_TOKEN as one or more `http.<url>.extraheader` entries; those override URL
 * credentials, can't modify workflow files, and — when more than one matches the push
 * URL — cause GitHub to reject the push with `Duplicate header: "Authorization"`.
 * So we remove every persisted extraheader and set exactly one with our token.
 */
export async function configureAuth(cwd: string, token: string): Promise<void> {
  const listed = await gitTry(cwd, [
    "config",
    "--local",
    "--name-only",
    "--get-regexp",
    "^http\\..*\\.extraheader$",
  ]);
  const keys =
    listed.code === 0
      ? [
          ...new Set(
            listed.stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ]
      : [];
  for (const key of keys) {
    await gitTry(cwd, ["config", "--local", "--unset-all", key]);
  }
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  await git(cwd, [
    "config",
    "--local",
    "http.https://github.com/.extraheader",
    `AUTHORIZATION: basic ${auth}`,
  ]);
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
    await configureAuth(opts.cwd, opts.token);
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
