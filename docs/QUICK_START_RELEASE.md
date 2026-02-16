# Quick Start: Creating a Release

Quick reference for maintainers creating a new FossClaw release.

## Prerequisites Checklist

- [ ] GPG key configured for signing
- [ ] Write access to repository
- [ ] Clean working directory (`git status`)
- [ ] All changes committed and pushed
- [ ] Tests passing locally (`bun test`)

## Release Process (5 Steps)

### 1. Create the Release Tag

```bash
./scripts/create-release.sh 0.2.0
```

This creates a GPG-signed tag and version bump commit.

### 2. Review Changes

```bash
git show v0.2.0
```

Verify:
- Version updated in `package.json` and `web/package.json`
- Tag is GPG-signed (`git tag -v v0.2.0`)

### 3. Push to GitHub

```bash
git push origin main
git push origin v0.2.0
```

### 4. Monitor Build

1. Go to [Actions tab](https://github.com/fosscode/fossclaw/actions)
2. Watch the "Release" workflow run
3. Wait for all platform builds to complete (~5-10 minutes)

Expected builds:
- ✅ darwin-arm64 (macOS Apple Silicon)
- ✅ darwin-x64 (macOS Intel)
- ✅ linux-x64
- ✅ linux-arm64
- ✅ windows-x64

### 5. Edit Release Notes

1. Go to [Releases page](https://github.com/fosscode/fossclaw/releases)
2. Click "Edit" on your new release
3. Add release notes (see template below)
4. Publish

## Release Notes Template

```markdown
## What's New

- Added session export functionality
- Improved WebSocket reconnection logic
- New dark mode theme

## Bug Fixes

- Fixed session persistence after server restart
- Resolved infinite loop in CLI launcher
- Fixed Windows binary startup issue

## Breaking Changes

> Only include if there are breaking changes

- Environment variable `FOSSCLAW_AUTH` removed (HTTPS/auth now mandatory)

## Installation

Download the appropriate binary for your platform below, or use Docker:

\`\`\`bash
docker run -p 3456:3456 ghcr.io/fosscode/fossclaw:v0.2.0
\`\`\`

See [Installation docs](https://github.com/fosscode/fossclaw#installation) for detailed setup.

## Contributors

Thanks to @contributor1, @contributor2 for their contributions to this release!
```

## Quick Verification

Test the release artifacts:

```bash
# Download and test macOS binary
curl -L https://github.com/fosscode/fossclaw/releases/download/v0.2.0/fossclaw-v0.2.0-darwin-arm64.tar.gz | tar xz
./fossclaw-darwin-arm64 &
curl https://localhost:3456/api/health
```

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

| Change Type | Example | When to Use |
|-------------|---------|-------------|
| **Patch** | 0.1.0 → 0.1.1 | Bug fixes only |
| **Minor** | 0.1.0 → 0.2.0 | New features, backwards compatible |
| **Major** | 0.9.0 → 1.0.0 | Breaking changes |

Pre-releases:
- `0.2.0-alpha.1` - Early testing
- `0.2.0-beta.1` - Feature complete, testing
- `0.2.0-rc.1` - Release candidate

## Troubleshooting

### GPG Signing Error

```bash
# Verify GPG is working
gpg --list-secret-keys
echo "test" | gpg --clearsign

# Check Git config
git config user.signingkey
```

### Build Failed on GitHub

1. Check [Actions logs](https://github.com/fosscode/fossclaw/actions)
2. Fix the issue
3. Delete failed tag:
   ```bash
   git tag -d v0.2.0
   git push origin :refs/tags/v0.2.0
   ```
4. Start over with fixed code

### Missing Binary

Re-run the failed job from the Actions UI:
1. Go to failed workflow run
2. Click "Re-run failed jobs"

## Post-Release

- [ ] Test download links work
- [ ] Verify checksums
- [ ] Update any deployment documentation
- [ ] Announce on GitHub Discussions
- [ ] Close related issues/milestones

## Emergency Hotfix

For critical bugs:

```bash
# Create hotfix branch
git checkout -b hotfix/0.1.1 v0.1.0

# Make fix and commit
git add .
git commit -m "fix: critical security issue"

# Create release
./scripts/create-release.sh 0.1.1

# Merge back
git checkout main
git merge hotfix/0.1.1
git push origin main v0.1.1
```

## Need Help?

- Full docs: [docs/RELEASE.md](./RELEASE.md)
- CI/CD docs: [docs/GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md)
- Contributing: [CONTRIBUTING.md](../CONTRIBUTING.md)
