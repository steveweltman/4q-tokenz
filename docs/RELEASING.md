# Releasing 4q-tokenz

Releases go to npm through Trusted Publishing from GitHub Actions. There is no
npm token to store or rotate. The npm rule (package Settings > Trusted Publisher)
allows only: repo `steveweltman/4q-tokenz`, workflow `release.yml`, environment
`npm-publish`, permission "npm stage publish". The workflow stages the release
and a human approves it. Two human gates exist: GitHub (deploy approval) and npm
(stage approval, with 2FA).

## One-time setup

1. npmjs.com, package `4q-tokenz`, Settings, Trusted Publisher: configured as above.
2. GitHub repo Settings > Environments > New environment, name exactly `npm-publish`.
   Tick "Required reviewers" and add `steveweltman`. Under "Deployment branches and
   tags", choose "Selected branches and tags" and add the tag rule `v*`.
   If the repo is private and the required-reviewer option is greyed out, the gate
   is unavailable on your plan. The npm approval step still protects the release.
3. Make sure `NPM_TOKEN` is not set as a repo secret, environment secret or variable.

## Before tagging (maintainer)

1. Run the security assessment (OWASP Top 10 2025, GCVE, OSV.dev) and save it in `docs/`.
2. Bump `version` in `package.json` and both versions in `server.json`.
3. Update the README changelog. Run `pnpm build && pnpm test`.
4. Commit and push `main`.

## Cut the release

```bash
git tag v1.23.0
git push origin v1.23.0
```

## Reviewer steps

Step A, GitHub approval (the run waits at "Waiting for review"):
1. Open the repo, Actions tab, the `release` run for the tag.
2. Check the run was triggered by the tag you pushed, on the commit you expect
   (`git rev-parse v1.23.0` should match the commit shown).
3. Click "Review deployments", tick `npm-publish`, click "Approve and deploy".
4. Wait for the job to finish. The "Verify versions match tag", test and
   "Stage publish to npm" steps must all be green.

Step B, npm approval (needs your npm login and 2FA; OIDC tokens cannot approve):
```bash
npm login
npm stage list 4q-tokenz
npm stage view 4q-tokenz@1.23.0
```
Check the version, file list and that provenance points to this repo and workflow.
Then approve, or discard:
```bash
npm stage approve 4q-tokenz@1.23.0
npm stage reject 4q-tokenz@1.23.0
```
Approval can also be done on the package page at npmjs.com.

Step C, verify:
```bash
npm view 4q-tokenz version
npm audit signatures
```
The package page should show a provenance badge.

## Notes

- First successful stage validates the trusted publisher (it is "Pending validation"
  until then and must be validated before the date npm shows on the setting).
- The workflow runs only on `vX.Y.Z` tag pushes. No PR triggers, no secrets.
- If the stage step fails with a permission error, check the repo, workflow file
  name, and environment name match npm's rule exactly (case sensitive).
- Once a release has worked, set the package to require 2FA and disallow tokens,
  then delete the old `npm-token-4q-tokenz` token on npmjs.com and its 1Password item.
  `npm-vault` is then only needed for other packages such as `openclaw`.
