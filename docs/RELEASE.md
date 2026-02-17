# Release Process

This document describes how to create a new release of FossClaw.

## Prerequisites

1. **GPG Key Setup**: Ensure you have a GPG key configured for signing commits and tags
   ```bash
   git config --global user.signingkey YOUR_GPG_KEY_ID
   git config --global commit.gpgsign true
   git config --global tag.gpgsign true
   ```

2. **GitHub Permissions**: You need write access to the repository and permission to create releases

3. **Clean Working Directory**: Ensure all changes are committed and pushed

## Release Steps

### 1. Run Local E2E Tests (Recommended)

Before creating a release, validate the build locally:

```bash
./scripts/run-e2e-tests.sh
```

This will:
- Build the binary for your platform
- Run comprehensive e2e tests
- Verify binary integrity, size, and functionality
- Test server startup and API endpoints

**Note**: Local tests only run on your platform. Full cross-platform testing happens in GitHub Actions.

### 2. Prepare the Release

Use the release helper script:

```bash
./scripts/create-release.sh <version>
```

Example:
```bash
./scripts/create-release.sh 0.2.0
```

This script will:
- Update version in `package.json` and `web/package.json`
- Create a version bump commit
- Create a GPG-signed tag
- Provide instructions for pushing

### 3. Push the Release

```bash
# Push the commit
git push origin main

# Push the GPG-signed tag
git push origin v<version>
```

### 4. Automated Build Process

GitHub Actions will automatically:
1. Build binaries for all platforms:
   - macOS (Apple Silicon - darwin-arm64)
   - macOS (Intel - darwin-x64)
   - Linux (x64 - linux-x64)
   - Linux (ARM64 - linux-arm64)
   - Windows (x64 - windows-x64)

2. Create compressed archives:
   - Unix: `.tar.gz` files
   - Windows: `.zip` files

3. Generate SHA256 checksums for all artifacts

4. Create a GitHub Release with all binaries attached

5. Publish to npm registry

6. Build and push Docker images

7. **Run E2E Release Tests** (new!):
   - Download and test binaries on all platforms
   - Verify npm package installation
   - Test OpenCode integration
   - Validate Docker images
   - Test quick install commands

**Monitor Progress**: Go to [Actions](https://github.com/fosscode/fossclaw/actions) and watch the workflows:
- `Release` - Builds binaries
- `Publish to NPM` - Publishes npm package
- `Docker` - Builds Docker images
- `E2E Release Tests` - Validates everything works

### 5. Verify E2E Tests Pass

**IMPORTANT**: Wait for the E2E tests to complete before announcing the release.

1. Go to [Actions → E2E Release Tests](https://github.com/fosscode/fossclaw/actions/workflows/e2e-release.yml)
2. Find the workflow run for your release tag
3. Check that all jobs passed:
   - ✅ Binary Download Tests
   - ✅ NPM Install Tests
   - ✅ OpenCode Integration
   - ✅ Docker Image Tests (may be skipped if image not ready)
   - ✅ Quick Install Tests

**If tests fail:**
- Review the test logs to identify the issue
- Consider yanking the npm package if it's broken: `npm unpublish fossclaw@<version>`
- Mark the GitHub release as draft
- Fix the issue
- Create a patch release (e.g., if 2.4.4 failed, release 2.4.5)

**See Also**: [E2E Testing Documentation](./E2E_TESTING.md)

### 6. Edit Release Notes

1. Go to the [Releases page](https://github.com/YOUR_ORG/fossclaw/releases)
2. Find your new release
3. Click "Edit release"
4. Update the release notes with:
   - What's new in this version
   - Breaking changes (if any)
   - Bug fixes
   - Contributors

**Release Notes Template:**

```markdown
## What's New

- Feature 1
- Feature 2

## Bug Fixes

- Fix 1
- Fix 2

## Breaking Changes

- Change 1 (if applicable)

## Installation

See installation instructions below for your platform.

## Contributors

Thanks to @contributor1, @contributor2 for their contributions!
```

### 5. Verify the Release

1. **Check Binary Downloads**: Download and test each binary
   ```bash
   # macOS Apple Silicon
   curl -L https://github.com/YOUR_ORG/fossclaw/releases/download/v0.2.0/fossclaw-v0.2.0-darwin-arm64.tar.gz | tar xz
   ./fossclaw-darwin-arm64 --version
   ```

2. **Verify Checksums**:
   ```bash
   # Download checksum file
   curl -L -O https://github.com/YOUR_ORG/fossclaw/releases/download/v0.2.0/SHA256SUMS.txt

   # Verify binary
   shasum -a 256 -c SHA256SUMS.txt
   ```

3. **Test Docker Image** (if published):
   ```bash
   docker pull ghcr.io/YOUR_ORG/fossclaw:v0.2.0
   docker run -p 3456:3456 ghcr.io/YOUR_ORG/fossclaw:v0.2.0
   ```

### 6. Announce the Release

- Post on GitHub Discussions
- Update README if needed
- Share on social media (if applicable)

## Version Numbering

FossClaw follows [Semantic Versioning](https://semver.org/):

- **MAJOR** version (x.0.0): Breaking changes
- **MINOR** version (0.x.0): New features, backwards compatible
- **PATCH** version (0.0.x): Bug fixes, backwards compatible

Examples:
- `0.1.0` → `0.1.1`: Bug fix
- `0.1.0` → `0.2.0`: New feature
- `0.9.0` → `1.0.0`: Major release with breaking changes

## Pre-releases

For alpha, beta, or release candidate versions:

```bash
./scripts/create-release.sh 0.2.0-alpha.1
./scripts/create-release.sh 0.2.0-beta.1
./scripts/create-release.sh 0.2.0-rc.1
```

GitHub Actions will automatically mark these as "pre-release" on GitHub.

## Hotfix Releases

For urgent bug fixes:

1. Create a hotfix branch from the tag:
   ```bash
   git checkout -b hotfix/0.1.1 v0.1.0
   ```

2. Make your fix and commit
   ```bash
   git add .
   git commit -m "fix: critical bug in session handling"
   ```

3. Create the release:
   ```bash
   ./scripts/create-release.sh 0.1.1
   ```

4. Push to main:
   ```bash
   git checkout main
   git merge hotfix/0.1.1
   git push origin main v0.1.1
   ```

## Troubleshooting

### GPG Signing Issues

If you get GPG errors:

```bash
# Check if GPG is working
gpg --list-secret-keys

# Test signing
echo "test" | gpg --clearsign

# Configure Git to use GPG
git config --global gpg.program gpg
```

### Build Failures

If the GitHub Actions build fails:

1. Check the [Actions tab](https://github.com/YOUR_ORG/fossclaw/actions)
2. Review the logs for the failed job
3. Fix the issue and create a new patch release
4. Delete the failed tag and release if needed:
   ```bash
   git tag -d v0.2.0
   git push origin :refs/tags/v0.2.0
   ```

### Missing Artifacts

If some platform binaries are missing:

1. Check the GitHub Actions workflow logs
2. Re-run failed jobs from the Actions UI
3. If the issue persists, open an issue with the logs

## Manual Release (Emergency)

If GitHub Actions is unavailable, you can create a release manually:

1. Build binaries locally:
   ```bash
   ./build-all.sh
   ```

2. Create release on GitHub:
   - Go to Releases → Draft a new release
   - Choose tag: v0.2.0
   - Fill in release notes
   - Upload binary files from `dist/`
   - Publish release

## Rollback

If a release has critical issues:

1. **Mark as pre-release** on GitHub to warn users
2. **Create hotfix** following the hotfix process above
3. **Communicate** the issue in release notes and discussions

Do not delete releases unless absolutely necessary (security issues, malware, etc.)
