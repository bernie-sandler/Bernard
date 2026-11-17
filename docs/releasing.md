# CI and releases

## Branches

Work happens on two long-lived branches. `dev` collects finished changes: feature and fix branches start from it and are squash-merged back into it. `main` holds released code and is the default branch. A release merges `dev` into `main` with a merge commit (not a squash, which would make the two branches' histories drift apart).

## CI

GitHub Actions run on every pull request to, and every push to, `main` and `dev` ([`ci.yml`](../.github/workflows/ci.yml)): Biome lint, typecheck, tests with coverage on Node 22 and 26, the production build, and a Docker image build. A final **CI passed** job sums them up. Mark it as the required status check in the branch protection rules for both `main` and `dev` so pull requests can only merge when everything is green. Every job has a time limit, so a hung step fails instead of running for hours.

Three more checks run alongside CI but aren't required:

- [`pr-title.yml`](../.github/workflows/pr-title.yml) checks that the title of a pull request into `dev` is a [Conventional Commit](https://www.conventionalcommits.org/) (`feat: ...`, `fix(api): ...`), since the squash merge turns the title into the commit message. Release pull requests into `main` and merges from `main` back into `dev` are skipped.
- [`codeql.yml`](../.github/workflows/codeql.yml) runs GitHub's CodeQL code scanning on the TypeScript code and the workflows, on every pull request and push and once a week. Findings show up under **Security → Code scanning**.
- [`actionlint.yml`](../.github/workflows/actionlint.yml) lints the workflow files (and the shell in them) whenever they change.

[Dependabot](../.github/dependabot.yml) opens weekly PRs (Mondays) against `dev` for pnpm packages, GitHub Actions and the Docker base image, with minor and patch bumps grouped into one PR per category. [`dependabot-auto-merge.yml`](../.github/workflows/dependabot-auto-merge.yml) queues patch and minor PRs to squash-merge once **CI passed** is green, and comments on major updates so you review them by hand. Auto-merge needs **Settings → General → Allow auto-merge** turned on. If `dev` has no required status check, the workflow only comments on the PR, because auto-merge would otherwise merge it before CI finishes.

## Releasing

[`release.yml`](../.github/workflows/release.yml) runs when a `vX.Y.Z` tag is pushed.

1. On a `release/x.y.z` branch from `dev`, bump `version` in `package.json` and move the `[Unreleased]` entries in `CHANGELOG.md` into a `## [x.y.z] - YYYY-MM-DD` section. Open a pull request into `dev` and merge it.
2. Open a pull request from `dev` into `main` titled `Release x.y.z` and merge it with **Create a merge commit**.
3. Once CI is green on `main`, tag it and push the tag:

   ```bash
   git tag vX.Y.Z
   ```

   ```bash
   git push origin vX.Y.Z
   ```

The release workflow checks that the tag matches `package.json` and is on `main`, runs the full CI suite again, publishes a multi-arch (amd64/arm64) image to `ghcr.io/bernie-sandler/bernard` tagged with the version, `major.minor` and `latest`, and creates a GitHub release whose notes are the version's `CHANGELOG.md` section.

## Release candidates

To try a numbered build before it reaches `main`, publish a release candidate from `dev` with [`prerelease.yml`](../.github/workflows/prerelease.yml). Run it from the Actions tab (**Prerelease** → **Run workflow** on `dev`) or with:

```bash
gh workflow run prerelease.yml --ref dev
```

It runs CI, publishes an image tagged like `0.2.0-rc.1` and moves the `rc` tag to it (never `latest`), and creates the `v0.2.0-rc.1` tag and a GitHub prerelease. Its notes are the version's `CHANGELOG.md` section if it already has one, otherwise the `[Unreleased]` section. To follow release candidates without changing the tag each time, run `ghcr.io/bernie-sandler/bernard:rc`. No version bump is needed: the version is the one in `package.json`, or the next patch version once that one is released, and each run counts up the `rc` number. Pass `-f version=0.3.0` to pick another version. Release candidates can't be published by pushing a tag.

## The `:dev` image

Every push to `dev` also publishes `ghcr.io/bernie-sandler/bernard:dev` ([`dev-image.yml`](../.github/workflows/dev-image.yml)), so a test container can follow unreleased changes without a version bump or tag. It is rebuilt and overwritten on each push, isn't a GitHub release, and can break between releases, so keep production on a version tag or `latest`. To rebuild it by hand, run the workflow from the Actions tab.

## Hotfixes

An urgent fix for a released version can skip `dev`: branch `fix/...` from `main` with the fix, its version bump and changelog section, merge it into `main` and tag it, then merge `main` back into `dev` with a merge commit.

## Pruning

GitHub keeps at most one release and one release candidate. Publishing a release deletes every older release and release candidate. Publishing a release candidate deletes older candidates but keeps the current release. Git tags are never removed, so any version can still be checked out.

The image registry is pruned to match by [`cleanup-images.yml`](../.github/workflows/cleanup-images.yml), which runs after each release, release candidate and `:dev` build. It keeps every version (`0.1.3`, `0.1`), `latest`, `dev`, `rc` and the current release candidate, and deletes older release candidates, `sha-*` tags and untagged leftovers of replaced `:dev` builds. Run it from the Actions tab with **dry run** ticked to see what it would delete.
