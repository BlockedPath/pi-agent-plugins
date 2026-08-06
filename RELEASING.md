# Releasing

The release workflow publishes with the `NPM_TOKEN` GitHub Actions secret when
set. If the secret is missing, it falls back to npm trusted publishing (OIDC).

## One-time setup

### Option A — `NPM_TOKEN` secret (recommended on self-hosted)

1. On npmjs.com → **Access Tokens** → create a **Granular Access Token**:
   - Permission: **Read and write** for package `pi-agent-plugins`
   - Bypass 2FA / automation-capable if offered
2. In GitHub: repo **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `NPM_TOKEN`
   - Value: the token (`npm_…`)

### Option B — npm trusted publisher (OIDC, no long-lived token)

In the npm package settings for `pi-agent-plugins`, add a GitHub Actions
trusted publisher with:

- Organization or user: `BlockedPath`
- Repository: `pi-agent-plugins`
- Workflow filename: `release.yml`
- Environment: leave blank unless the workflow is updated to use one

## Publish a release

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run:

   ```bash
   npm run typecheck
   npm test
   npm pack --dry-run
   ```

3. Commit and push the version change to `main`.
4. Create and push the matching tag, for example:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

The pinned release workflow validates the tagged commit, publishes to npm,
and creates the GitHub release. Provenance attestations are omitted because
Sigstore/Fulcio TLS fails on the self-hosted Windows runner.

Do not push a release tag until npm trusted publishing is configured. npm
versions are immutable: if publish succeeded, do not retry that version. If
publish failed before the package was accepted, re-run via workflow_dispatch
with the same tag (uses the workflow from `main`, checks out the tag).
