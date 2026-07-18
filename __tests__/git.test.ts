import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { reconcileRepo } from "../src/core.js";
import { discover } from "../src/discover.js";
import { commitAndPush, configureAuth } from "../src/git.js";
import { buildSchedule, type RawSchedule } from "../src/schedule.js";

const rawSchedule = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/schedule.json", import.meta.url)),
    "utf8",
  ),
) as RawSchedule;
const schedule = buildSchedule(rawSchedule, new Date("2025-07-01T00:00:00Z"));
const fixtureRepo = fileURLToPath(new URL("./fixtures/repo", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "nvs-git-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("commitAndPush", () => {
  it("creates one commit per version change and pushes the branch", async () => {
    const origin = join(scratch, "origin.git");
    const work = join(scratch, "work");
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "--bare", "--initial-branch=main");

    // Seed the working repo from the fixture and push an initial main.
    mkdirSync(work, { recursive: true });
    git(work, "init", "--initial-branch=main");
    git(work, "config", "user.name", "seed");
    git(work, "config", "user.email", "seed@example.com");
    cpSync(fixtureRepo, work, { recursive: true });
    git(work, "add", "-A");
    git(work, "commit", "-m", "chore: initial");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "origin", "main");

    const discovered = await discover(work);
    const result = await reconcileRepo(discovered, schedule);

    await commitAndPush(result, {
      cwd: work,
      branch: "chore/node-version-sync",
      base: "main",
      owner: "acme",
      repo: "widgets",
      token: "unused",
      userName: "github-actions[bot]",
      userEmail: "bot@example.com",
      remoteUrl: origin,
    });

    // The branch exists on origin with the three expected commits, newest first:
    // drops lead (committed first), then adds ascending.
    const log = git(
      origin,
      "log",
      "chore/node-version-sync",
      "--format=%s",
    ).split("\n");
    expect(log.slice(0, 3)).toEqual([
      "feat: Add support for node version 24",
      "feat: Add support for node version 22",
      "feat!: Drop support for node version 18",
    ]);

    // The drop-18 commit bundles the .nvmrc and package.json (engines) edits.
    const dropSha = git(
      origin,
      "log",
      "chore/node-version-sync",
      "--format=%H",
      "--grep=Drop support",
    );
    const dropDiff = git(origin, "show", "--name-only", "--format=", dropSha);
    expect(dropDiff).toContain(".nvmrc");
    expect(dropDiff).toContain("package.json");

    // Final tree on the branch reflects all reconciled changes.
    const finalNvmrc = git(origin, "show", "chore/node-version-sync:.nvmrc");
    expect(finalNvmrc).toBe("24");
  });

  it("configureAuth removes every persisted extraheader and leaves exactly one for the token", async () => {
    const work = join(scratch, "auth");
    mkdirSync(work, { recursive: true });
    git(work, "init", "--initial-branch=main");
    // Simulate actions/checkout persisting the GITHUB_TOKEN, plus a second matching
    // header (the shape that caused "Duplicate header: Authorization").
    git(
      work,
      "config",
      "--local",
      "http.https://github.com/.extraheader",
      "AUTHORIZATION: basic OLD1",
    );
    git(
      work,
      "config",
      "--local",
      "--add",
      "http.https://github.com/acme/widgets.extraheader",
      "AUTHORIZATION: basic OLD2",
    );

    await configureAuth(work, "MYTOKEN");

    const keys = git(
      work,
      "config",
      "--local",
      "--name-only",
      "--get-regexp",
      "^http\\..*\\.extraheader$",
    )
      .split("\n")
      .filter(Boolean);
    expect(keys).toEqual(["http.https://github.com/.extraheader"]);

    const value = git(
      work,
      "config",
      "--local",
      "--get",
      "http.https://github.com/.extraheader",
    );
    const expected = `AUTHORIZATION: basic ${Buffer.from("x-access-token:MYTOKEN").toString("base64")}`;
    expect(value).toBe(expected);
  });
});
