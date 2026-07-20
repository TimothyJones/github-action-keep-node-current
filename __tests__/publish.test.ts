import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reconcileRepo } from "../src/core.js";
import { discover } from "../src/discover.js";
import type { Octokit } from "../src/pr.js";
import { publishChanges } from "../src/publish.js";
import { buildSchedule, type RawSchedule } from "../src/schedule.js";

const rawSchedule = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/schedule.json", import.meta.url)),
    "utf8",
  ),
) as RawSchedule;
const schedule = buildSchedule(rawSchedule, new Date("2025-07-01T00:00:00Z"));
const repoRoot = fileURLToPath(new URL("./fixtures/repo", import.meta.url));

interface Recorder {
  trees: Array<{ base_tree: string; paths: string[] }>;
  commits: Array<{ message: string; tree: string; parents: string[] }>;
  refs: Array<[string, { ref: string; sha: string; force?: boolean }]>;
  pulls: string[];
}

/** A fake octokit that records Git Data + pulls calls and returns chained SHAs. */
function mockOctokit(existingPr: number | null = null) {
  const rec: Recorder = { trees: [], commits: [], refs: [], pulls: [] };
  let n = 0;
  let updateRefFails = false;

  const octokit = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: "base-sha" } } }),
        getCommit: async () => ({ data: { tree: { sha: "base-tree" } } }),
        createTree: async ({ base_tree, tree }: any) => {
          rec.trees.push({ base_tree, paths: tree.map((t: any) => t.path) });
          return { data: { sha: `tree-${++n}` } };
        },
        createCommit: async ({ message, tree, parents }: any) => {
          rec.commits.push({ message, tree, parents });
          return { data: { sha: `commit-${n}` } };
        },
        updateRef: async (args: any) => {
          if (updateRefFails) throw new Error("ref not found");
          rec.refs.push(["update", args]);
          return {};
        },
        createRef: async (args: any) => {
          rec.refs.push(["create", args]);
          return {};
        },
      },
      pulls: {
        list: async () => ({
          data: existingPr
            ? [{ number: existingPr, html_url: `http://pr/${existingPr}` }]
            : [],
        }),
        create: async () => {
          rec.pulls.push("create");
          return { data: { html_url: "http://pr/1", number: 1 } };
        },
        update: async () => {
          rec.pulls.push("update");
          return {};
        },
      },
    },
  };
  return {
    octokit: octokit as unknown as Octokit,
    rec,
    failUpdateRef: () => (updateRefFails = true),
  };
}

const opts = {
  owner: "acme",
  repo: "widgets",
  base: "main",
  branch: "chore/node-version-sync",
  root: repoRoot,
  title: "feat!: ...",
  body: "body",
};

describe("publishChanges", () => {
  it("builds one chained commit per group and points the branch at the tip", async () => {
    const result = await reconcileRepo(await discover(repoRoot), schedule);
    const { octokit, rec } = mockOctokit();

    const pr = await publishChanges(octokit, result, opts);

    // Three commits: drop 18 (first), add 22, add 24 — in group order.
    expect(rec.commits.map((c) => c.message)).toEqual([
      "feat!: Drop support for node version 18",
      "feat: Add support for node version 22",
      "feat: Add support for node version 24",
    ]);

    // Commits chain off the base and each other; trees stack on the previous tree.
    expect(rec.commits[0].parents).toEqual(["base-sha"]);
    expect(rec.commits[1].parents).toEqual(["commit-1"]);
    expect(rec.commits[2].parents).toEqual(["commit-2"]);
    expect(rec.trees[0].base_tree).toBe("base-tree");
    expect(rec.trees[1].base_tree).toBe("tree-1");

    // The drop-18 commit carries the repo-relative, POSIX-style paths.
    expect(rec.trees[0].paths).toContain(".nvmrc");
    expect(rec.trees[0].paths).toContain("package.json");
    expect(rec.trees[0].paths).toContain(".github/workflows/ci.yml");

    // Branch updated to the final commit (force), then a PR opened.
    expect(rec.refs).toEqual([
      [
        "update",
        {
          owner: "acme",
          repo: "widgets",
          ref: "heads/chore/node-version-sync",
          sha: "commit-3",
          force: true,
        },
      ],
    ]);
    expect(pr).toMatchObject({ url: "http://pr/1", number: 1, commits: 3 });
  });

  it("creates the branch ref when it does not yet exist", async () => {
    const result = await reconcileRepo(await discover(repoRoot), schedule);
    const { octokit, rec, failUpdateRef } = mockOctokit();
    failUpdateRef();

    await publishChanges(octokit, result, opts);
    expect(rec.refs[0][0]).toBe("create");
    expect(rec.refs[0][1].ref).toBe("refs/heads/chore/node-version-sync");
  });

  it("updates an existing open PR instead of creating one", async () => {
    const result = await reconcileRepo(await discover(repoRoot), schedule);
    const { octokit, rec } = mockOctokit(42);

    const pr = await publishChanges(octokit, result, opts);
    expect(rec.pulls).toEqual(["update"]);
    expect(pr).toMatchObject({ number: 42 });
  });
});
