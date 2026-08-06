# Releasing

The release workflow publishes every version to two registries:

- `pi-agent-plugins` on npmjs.org using the `NPM_TOKEN` repository secret.
- `@blockedpath/pi-agent-plugins` on GitHub Packages using `GITHUB_TOKEN`.

Both publish steps are idempotent: a rerun skips a version that already exists.

## One-time setup

1. On npmjs.com → **Access Tokens** → create a **Granular Access Token**:
   - Permission: **Read and write** for package `pi-agent-plugins`
   - Bypass 2FA / automation-capable if offered
2. In GitHub: repo **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `NPM_TOKEN`
   - Value: the token (`npm_…`)
3. After the first GitHub Packages publish, open the package settings and set
   its visibility to **Public**. GitHub defaults new packages to private.

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

The pinned release workflow validates the tagged commit, publishes to npmjs
and GitHub Packages, and creates the GitHub release. Provenance attestations
are omitted because Sigstore/Fulcio TLS fails on the self-hosted Windows
runner.

Reruns are safe: existing registry versions and GitHub releases are skipped.
Use workflow_dispatch with the same tag to fill in any missing publish target.
The workflow itself runs from `main` and checks out the requested tag.

Install from npmjs (default):

```bash
npm install pi-agent-plugins
```

Install the GitHub Packages mirror (GitHub authentication may be required):

```bash
npm install @blockedpath/pi-agent-plugins \
  --registry=https://npm.pkg.github.com
```
