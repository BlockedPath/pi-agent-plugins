# Releasing

The release workflow uses npm trusted publishing with GitHub Actions OIDC. It does not use a long-lived npm token.

## One-time npm setup

In the npm package settings for `pi-agent-plugins`, add a GitHub Actions trusted publisher with:

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

The pinned release workflow validates the tagged commit, publishes to npm with provenance, and creates the GitHub release. Do not push a release tag until npm trusted publishing is configured; npm versions are immutable and a failed workflow should not be retried after publishing that version manually.
