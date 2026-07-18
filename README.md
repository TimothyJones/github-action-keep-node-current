# Node Version Sync

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

The PR title is composed from all the changes:

- adds only — `feat: Add support for node version 22, 24`
- drops only — `feat!: Drop support for node version 18`
- both — `feat!: Add support for node version 24, drop support for node version 18`

The `!` (breaking-change marker) appears whenever anything is dropped.

## Usage

Run it on a schedule so your matrices stay current automatically:

```yaml
# .github/workflows/node-version-sync.yml
name: Node Version Sync
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
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/node-version-sync@v1
        with:
          # Required to edit workflow files — see the token note below.
          token: ${{ secrets.SYNC_PAT }}
```

> **Token — important.** Because this action edits files under `.github/workflows/`, the
> default `GITHUB_TOKEN` is **not sufficient** — GitHub refuses pushes that create or
> update workflow files unless the token has the `workflow` scope. See
> [Setting up the token](#setting-up-the-token) below.
>
> (The default `GITHUB_TOKEN` works only if none of the changed files are workflows —
> e.g. you limit scope to `.nvmrc` / `package.json` via the `paths` input.)

## Setting up the token

The action needs a token with the **`workflow`** scope so it can push workflow-file
changes and open the PR. Set one up in three steps.

### 1. Create the token

**Option A — Fine-grained PAT (recommended, least privilege):**

1. Go to **Settings → Developer settings → Fine-grained personal access tokens → Generate new token**
   (<https://github.com/settings/personal-access-tokens/new>).
2. **Resource owner:** you or your org · **Repository access:** _Only select repositories_ →
   choose the repo(s) that will run the action.
3. Under **Permissions → Repository permissions**, set each of these to _Read and write_:
   - **Contents**
   - **Pull requests**
   - **Workflows**
4. Generate the token and copy it.

**Option B — Classic PAT (simplest):**

1. Go to **Settings → Developer settings → Tokens (classic) → Generate new token**
   (<https://github.com/settings/tokens/new>).
2. Select the **`repo`** and **`workflow`** scopes.
3. Generate the token and copy it.

**Option C — GitHub App token:** an installation token with `contents: write`,
`pull-requests: write` and `workflows: write` also works, and is a good fit for orgs.

### 2. Store it as a secret

Add the token as a repository (or organisation) secret, e.g. `SYNC_PAT`:

```bash
gh secret set SYNC_PAT --repo <owner>/<repo>
# then paste the token when prompted
```

Or via **Settings → Secrets and variables → Actions → New repository secret**.

### 3. Reference it in the workflow

```yaml
- uses: your-org/node-version-sync@v1
  with:
    token: ${{ secrets.SYNC_PAT }}
```

### Also required

- The job must grant `permissions: contents: write` and `pull-requests: write`
  (see the [example](#usage) above).
- The repo setting **Settings → Actions → General → "Allow GitHub Actions to create and
  approve pull requests"** must be enabled.

Commits are authored as `github-actions[bot]`; the PR is opened by the token's owner.
Using a PAT/App token (rather than `GITHUB_TOKEN`) also lets the opened PR trigger other
workflows, such as CI.

## Inputs

| Input          | Default                   | Description                                                                          |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `token`        | `${{ github.token }}`     | Token used to push the branch and open the PR.                                       |
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
