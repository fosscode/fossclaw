# GitHub Actions Workflows

FossClaw uses GitHub Actions for comprehensive CI/CD automation. This document describes all workflows and how to configure them.

## Workflows Overview

### 1. CI Workflow (`.github/workflows/ci.yml`)

**Trigger**: Push to `main`, Pull Requests

**Purpose**: Continuous integration checks on every code change

**Jobs**:
- **Test**: Runs test suite with `bun test`
- **Type Check**: Validates TypeScript types with `tsc --noEmit`
- **Build**: Builds frontend and verifies output
- **Build Binary**: Tests binary compilation for macOS and Linux

**Matrix**:
- Platforms: macOS (arm64), Linux (x64)

---

### 2. Release Workflow (`.github/workflows/release.yml`)

**Trigger**: Git tags matching `v*` (e.g., `v0.2.0`)

**Purpose**: Build and publish multi-platform binaries

**Jobs**:

#### Build Job
Builds binaries for all platforms using a matrix strategy:

| Platform | Arch | OS | Binary Name |
|----------|------|-----|-------------|
| macOS | ARM64 | macos-latest | `fossclaw-darwin-arm64` |
| macOS | x64 | macos-13 | `fossclaw-darwin-x64` |
| Linux | x64 | ubuntu-latest | `fossclaw-linux-x64` |
| Linux | ARM64 | ubuntu-latest | `fossclaw-linux-arm64` |
| Windows | x64 | windows-latest | `fossclaw-windows-x64.exe` |

**Build Process**:
1. Install Bun
2. Build frontend with Vite
3. Create standalone entry point
4. Copy server files and assets
5. Compile binary with `bun build --compile`
6. Create compressed archives (`.tar.gz` for Unix, `.zip` for Windows)
7. Generate SHA256 checksums

#### Release Job
1. Download all build artifacts
2. Consolidate into single directory
3. Generate combined SHA256SUMS.txt
4. Create GitHub Release with auto-generated installation instructions
5. Upload all binaries and checksums

---

### 3. CodeQL Security Scan (`.github/workflows/codeql.yml`)

**Trigger**:
- Push to `main`
- Pull Requests
- Weekly on Monday (cron: `0 0 * * 1`)

**Purpose**: Automated security vulnerability scanning

**Features**:
- Scans JavaScript/TypeScript code
- Uses `security-extended` and `security-and-quality` query suites
- Results appear in Security → Code scanning alerts

---

### 4. Docker Build (`.github/workflows/docker.yml`)

**Trigger**:
- Push to `main`
- Git tags `v*`
- Pull Requests

**Purpose**: Build and publish Docker images to GitHub Container Registry

**Images Built**:
- `ghcr.io/YOUR_ORG/fossclaw:main` (latest main branch)
- `ghcr.io/YOUR_ORG/fossclaw:v0.2.0` (version tag)
- `ghcr.io/YOUR_ORG/fossclaw:0.2` (major.minor)
- `ghcr.io/YOUR_ORG/fossclaw:0` (major)
- `ghcr.io/YOUR_ORG/fossclaw:sha-abc123` (git sha)

**Platforms**:
- `linux/amd64`
- `linux/arm64`

**Features**:
- Multi-arch builds
- Build cache optimization
- Automatic metadata extraction

---

### 5. NPM Publish (`.github/workflows/npm-publish.yml`)

**Trigger**: GitHub Release published

**Purpose**: Publish package to npm registry

**Steps**:
1. Build frontend
2. Update package.json version
3. Publish to npm with provenance

**Required Secret**: `NPM_TOKEN`

---

### 6. PR Labeler (`.github/workflows/labeler.yml`)

**Trigger**: Pull Request events (opened, synchronized)

**Purpose**: Auto-label PRs based on changed files

**Labels Applied**:
- `area: frontend` - Changes to `web/src/**`
- `area: server` - Changes to `web/server/**`
- `area: build` - Changes to build scripts, Dockerfile
- `area: ci` - Changes to `.github/**`
- `area: docs` - Changes to `*.md` or `docs/**`
- `dependencies` - Changes to `package.json` or lock files

---

## Setup & Configuration

### Required Secrets

Configure these in **Settings → Secrets and variables → Actions**:

| Secret | Required For | Description |
|--------|-------------|-------------|
| `GITHUB_TOKEN` | All workflows | Auto-provided by GitHub |
| `NPM_TOKEN` | NPM Publishing | npm access token (optional) |

### Optional Configuration

#### 1. Enable Docker Publishing

Docker publishing is enabled by default. To disable:

- Remove or comment out `.github/workflows/docker.yml`

#### 2. Enable npm Publishing

To publish to npm:

1. Create npm account and generate token
2. Add `NPM_TOKEN` secret to repository
3. Update package name in `web/package.json` if needed

#### 3. Customize CodeQL Schedule

Edit `.github/workflows/codeql.yml`:

```yaml
schedule:
  - cron: '0 0 * * 1'  # Every Monday at midnight UTC
```

#### 4. Configure Dependabot

Dependabot is configured in `.github/dependabot.yml`:

- **npm dependencies**: Weekly updates on Monday
- **GitHub Actions**: Weekly updates on Monday

To customize:

```yaml
schedule:
  interval: "daily"  # or "weekly", "monthly"
  day: "monday"
```

---

## Workflow Badges

Add badges to your README:

```markdown
[![CI](https://github.com/YOUR_ORG/fossclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_ORG/fossclaw/actions/workflows/ci.yml)
[![Release](https://github.com/YOUR_ORG/fossclaw/actions/workflows/release.yml/badge.svg)](https://github.com/YOUR_ORG/fossclaw/actions/workflows/release.yml)
[![CodeQL](https://github.com/YOUR_ORG/fossclaw/actions/workflows/codeql.yml/badge.svg)](https://github.com/YOUR_ORG/fossclaw/actions/workflows/codeql.yml)
[![Docker](https://github.com/YOUR_ORG/fossclaw/actions/workflows/docker.yml/badge.svg)](https://github.com/YOUR_ORG/fossclaw/actions/workflows/docker.yml)
```

---

## Monitoring Workflows

### View Workflow Runs

1. Go to **Actions** tab
2. Select a workflow from the left sidebar
3. View run history, logs, and artifacts

### Workflow Status

- ✅ Green checkmark: Success
- ❌ Red X: Failure
- 🟡 Yellow dot: In progress
- ⚫ Gray circle: Pending

### Debugging Failed Workflows

1. Click on the failed workflow run
2. Click on the failed job
3. Expand the failed step to see logs
4. Fix the issue and push again (or re-run if transient)

### Re-running Workflows

- **Re-run all jobs**: Click "Re-run all jobs" button
- **Re-run failed jobs**: Click "Re-run failed jobs" button

---

## Advanced Usage

### Manual Workflow Trigger

To allow manual triggers, add to workflow:

```yaml
on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to build'
        required: true
```

### Skip CI

Add `[skip ci]` to commit message to skip workflows:

```bash
git commit -m "docs: update README [skip ci]"
```

### Workflow Dependencies

Run workflows sequentially:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    # ...

  deploy:
    needs: build  # Wait for build to complete
    runs-on: ubuntu-latest
    # ...
```

---

## Performance Optimization

### Build Cache

Workflows use caching to speed up builds:

- **Bun dependencies**: Cached by `oven-sh/setup-bun`
- **Docker layers**: Cached with `cache-from: type=gha`

### Matrix Strategy

Parallel builds across platforms reduce total build time:

```yaml
strategy:
  matrix:
    platform: [darwin, linux, windows]
    arch: [x64, arm64]
```

---

## Security Best Practices

1. **Least Privilege**: Workflows use minimal required permissions
2. **Dependabot**: Auto-updates dependencies to fix vulnerabilities
3. **CodeQL**: Weekly security scans
4. **Secrets**: Never log or expose secrets
5. **Provenance**: npm publish includes attestation

---

## Troubleshooting

### "Resource not accessible by integration"

- Check workflow permissions in Settings → Actions → General
- Ensure repository allows workflow write access

### Binary Build Fails

- Check Bun version compatibility
- Verify all dependencies are included in build

### Docker Build Fails

- Verify Dockerfile syntax
- Check multi-arch build support

### NPM Publish Fails

- Verify `NPM_TOKEN` is set correctly
- Check package name is not already taken
- Ensure version is unique

---

## Cost Optimization

GitHub Actions minutes are free for public repositories. For private repos:

- **Linux**: Standard minutes
- **macOS**: 10x multiplier
- **Windows**: 2x multiplier

To reduce costs:
- Use Linux runners when possible
- Cache dependencies aggressively
- Skip unnecessary jobs with path filters

---

## Future Improvements

Potential enhancements:

- [ ] Automated changelog generation
- [ ] Performance benchmarking
- [ ] Visual regression testing
- [ ] Deployment previews for PRs
- [ ] Automated npm canary releases
- [ ] Release candidate automation
