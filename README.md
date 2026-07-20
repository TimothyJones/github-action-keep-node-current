# Keep Node Current

A GitHub Action that keeps the Node.js versions declared across your repository in
sync with the [official Node.js release schedule](https://github.com/nodejs/Release),
and opens a pull request with the changes.

On each run it:

1. Fetches the live release schedule.
2. Reconciles every place Node versions are declared (see [What it edits](#what-it-edits)).
3. Opens **one PR** with a separate commit per version added or dropped.

## What it edits

| Location                                                                         | Rule                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A CI **matrix** feeding `actions/setup-node` (e.g. `matrix: node: [18, 20, 22]`) | Must contain **all active even (LTS) majors** — missing ones are added, end-of-life ones are removed.                                                                                                                        |
| A **single `node-version:` pin** on `actions/setup-node`                         | Left alone while its major is still supported; once it reaches end-of-life it is bumped to the **newest even active** major.                                                                                                 |
| **`.nvmrc`**                                                                     | Treated as a single-version pin (same rule as above).                                                                                                                                                                        |
| **`package.json` `engines.node`**                                                | The floor is raised to `>=<lowest even active>.0.0` **only when the current floor is below it**. A floor already at or above the lowest even active (e.g. `>=20.19`) is left untouched. Absent `engines.node` is left alone. |

A "version" is only touched when written as a concrete number (`20`, `"20"`, `20.x`,
`20.11.1`). Aliases such as `lts/*`, `latest`, and codenames are never changed or removed.

### Commits and PR title

Each change is its own commit:

- `feat: Add support for node version X`
- `feat!: Drop support for node version X`

The PR title is composed from all the changes (drops lead, then adds):

- adds only — `feat: Add support for node version 22, 24`
- drops only — `feat!: Drop support for node version 18`
- both — `feat!: Drop support for node version 18, add support for node version 24`

The `!` (breaking-change marker) appears whenever anything is dropped.

Bumping a single-version pin counts as **both** a drop of its old (EOL) major and an
add of the new one — e.g. moving a `.nvmrc` from `20` to `26` yields
`feat!: Drop support for node version 20, add support for node version 26`.

## Usage

Run it on a schedule so your matrices stay current automatically:

```yaml
# .github/workflows/node-version-sync.yml
name: Keep Node Current
on:
  schedule:
    - cron: "0 6 * * 1" # every Monday
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # lets the job federate its identity with Octo STS
    steps:
      - uses: actions/checkout@v4
      # Exchange this workflow's identity for a short-lived GitHub token.
      # No stored secrets — see "Authentication" below.
      - uses: octo-sts/action@main # pin to a release or SHA in production
        id: octo-sts
        with:
          scope: <owner>/<repo>
          identity: keep-node-current
      - uses: TimothyJones/github-action-keep-node-current@v1
        with:
          token: ${{ steps.octo-sts.outputs.token }}
```

> **Why not the default `GITHUB_TOKEN`?** Because this action edits files under
> `.github/workflows/`, and GitHub refuses to create or update workflow files unless the
> credential has the `workflow` scope — which `GITHUB_TOKEN` lacks. See
> [Authentication](#authentication).

## Authentication

The action commits, branches, and opens the PR entirely through the GitHub API, so it
needs no special `actions/checkout` configuration — just a credential allowed to edit
workflow files (the `workflow` scope / **Workflows: write** permission), supplied via the
`token` input.

### Recommended — Octo STS (no stored secrets)

[Octo STS](https://github.com/octo-sts/app) exchanges a workflow's built-in OIDC identity
for a **short-lived (1 hour) GitHub token**, scoped by a trust policy you commit to the
repo. There is **no long-lived credential stored anywhere** — nothing to leak from repo
settings, nothing to expire or rotate. The trust policy is reviewable code.

1. **Install the [Octo STS app](https://github.com/apps/octo-sts)** on the repo(s) that
   will run this action.
2. **Commit a trust policy** at `.github/chainguard/keep-node-current.sts.yaml`:

   ```yaml
   issuer: https://token.actions.githubusercontent.com
   # Only this repo's sync workflow, running on main, may mint this token:
   subject: repo:<owner>/<repo>:ref:refs/heads/main

   permissions:
     contents: write
     pull_requests: write
     workflows: write
   ```

3. **Mint the token in the workflow and pass it in** (as in [Usage](#usage) above): the
   job needs `permissions: id-token: write`, the
   [`octo-sts/action`](https://github.com/octo-sts/action) step exchanges the identity
   (`identity` = the policy filename without `.sts.yaml`), and its `token` output goes to
   this action's `token` input.

Octo STS is an open-source hosted service by Chainguard; if a third-party broker doesn't
fit your threat model, use a PAT below (or self-host Octo STS).

### Fallback — a Personal Access Token

A PAT works with no third-party involvement. Note PATs expire and are tied to your
account, so you'll have to rotate them.

- **Fine-grained PAT:** _Only select repositories_ → the target repo(s); permissions
  **Contents**, **Pull requests**, and **Workflows** = _Read and write_.
- **Classic PAT:** the `repo` and `workflow` scopes.

Store it as a secret and pass it in:

```yaml
with:
  token: ${{ secrets.SYNC_PAT }}
```

> **Hardening tip:** put the secret in a GitHub **Environment** restricted to your default
> branch (optionally with required reviewers) and reference that environment from the sync
> job — then other workflows and PR branches cannot read it.

The default `GITHUB_TOKEN` works **only** if none of the changed files are workflows
(e.g. you limit scope to `.nvmrc` / `package.json` via the `paths` input).

### Also required

- The job must grant `permissions: contents: write` and `pull-requests: write`
  (see the [example](#usage) above).
- The repo setting **Settings → Actions → General → "Allow GitHub Actions to create and
  approve pull requests"** must be enabled.

Commits are authored as `github-actions[bot]`; the PR is opened by the token's owner.
Using an Octo STS token or PAT (rather than `GITHUB_TOKEN`) also lets the opened PR
trigger other workflows, such as CI.

## Inputs

| Input          | Default                   | Description                                                                          |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `token`        | `${{ github.token }}`     | Token for commits/branch/PR. Needs the `workflow` scope; Octo STS token recommended. |
| `schedule-url` | Node.js `schedule.json`   | URL (or local path) of the release schedule.                                         |
| `base`         | repo default branch       | Base branch the PR targets.                                                          |
| `branch`       | `chore/node-version-sync` | Working branch the PR is opened from.                                                |
| `paths`        | _(auto-discover)_         | Newline/comma-separated explicit file paths to scan instead of auto-discovery.       |
| `dry-run`      | `false`                   | Compute and log changes without committing or opening a PR.                          |
| `now`          | _(today)_                 | Override the current date (`YYYY-MM-DD`) used to evaluate the schedule. Testing aid. |

## Outputs

| Output      | Description                                           |
| ----------- | ----------------------------------------------------- |
| `changed`   | `true` if any changes were made.                      |
| `added`     | Comma-separated majors for which support was added.   |
| `removed`   | Comma-separated majors for which support was dropped. |
| `pr-url`    | URL of the created/updated PR (empty if none).        |
| `pr-number` | Number of the created/updated PR (empty if none).     |

## Development

```bash
npm install
npm test           # vitest unit + integration tests
npm run typecheck  # tsc --noEmit
npm run build      # bundle src/ into dist/ with ncc (dist/ is committed)
```

`dist/` is the compiled entrypoint and **must be committed**; CI verifies it is up to date.

## Notes and limitations

- Matrix arrays are re-emitted compactly (`[20, 22, 24]`); comments and quote styles are preserved.
- `strategy.matrix` list arrays are edited; `include`/`exclude`-only or `fromJSON(...)` matrices are
  left untouched.
- When workflows declare inconsistent matrices, a version newly added to one file produces an
  `Add support` commit even if another file already listed it — after the run every matrix is complete.
