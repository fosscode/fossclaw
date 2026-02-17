# E2E Release Testing

This document describes the end-to-end (e2e) testing strategy for FossClaw releases.

## Overview

E2E tests validate that releases work correctly for end users by testing:
- Binary downloads and execution
- NPM package installation
- Docker image availability
- OpenCode integration
- Quick install commands from README

## Test Suites

### 1. GitHub Actions E2E Tests (`.github/workflows/e2e-release.yml`)

Runs automatically after each release is published. Tests the actual release artifacts as they would be consumed by users.

#### Test Jobs

##### `e2e-binary-download`
Tests binary downloads on all platforms (macOS, Linux, Windows).

**What it tests:**
- Download release archive from GitHub
- Extract archive successfully
- Binary exists and has correct size (>20MB)
- Binary is executable
- Server can start up

**Platforms:**
- macOS (Apple Silicon)
- Linux (x64)
- Windows (x64)

##### `e2e-npm-install`
Tests NPM package installation.

**What it tests:**
- Wait for package to be published to npm registry
- `npm install fossclaw@VERSION` works
- `npx fossclaw@VERSION` can execute

**Notes:**
- Waits up to 5 minutes for package to be available on npm
- Tests both `npm install` and `npx` execution

##### `e2e-opencode-integration`
Tests OpenCode bridge functionality.

**What it tests:**
- Download and run Linux binary
- Start FossClaw server with OpenCode port
- Test `/api/health` endpoint
- Test `/api/opencode/models` endpoint

**Prerequisites:**
- Runs on Ubuntu only (uses OpenCode which requires Linux)

##### `e2e-docker-pull`
Tests Docker image availability.

**What it tests:**
- Wait for Docker image to be published
- Pull image from GHCR
- Run container with environment variables
- Verify container starts successfully

**Notes:**
- Non-blocking (failures don't fail the workflow)
- Docker publish happens separately and may take longer

##### `e2e-quick-install`
Tests the quick install commands from README.

**What it tests:**
- Download release using the exact curl command from README
- Extract to test directory
- Verify binary is present and executable

**Platforms:**
- macOS
- Linux

##### `e2e-results`
Aggregates results from all test jobs.

**What it does:**
- Creates summary of all test results
- Fails if any critical tests failed
- Provides GitHub Actions summary output

#### Running Manually

You can trigger the e2e tests manually for any release tag:

```bash
# Go to: Actions -> E2E Release Tests -> Run workflow
# Enter the release tag (e.g., v2.4.4)
```

Or via `gh` CLI:

```bash
gh workflow run e2e-release.yml -f tag=v2.4.4
```

### 2. Local E2E Tests (`web/test/e2e-release.test.ts`)

Run locally before creating a release to validate the build.

#### Prerequisites

Build the binary first:

```bash
./build.sh
```

This creates `dist/fossclaw-{platform}-{arch}` binary.

#### Running Tests

```bash
cd web
bun test e2e-release.test.ts
```

#### What it Tests

##### Binary Integrity
- Binary exists at expected path
- Size is reasonable (20-200 MB)
- Contains expected embedded strings (React, Hono)
- Has executable permissions (Unix only)

##### Server Functionality
- Binary is executable
- Server starts successfully
- Health endpoint responds
- Sessions endpoint works
- OpenCode models endpoint works
- Static files are served

##### Archive Contents
- README.md present in dist
- LICENSE present in dist
- checksums.txt present in dist

## Test Matrix

| Test | GitHub Actions | Local | Platforms | Triggers |
|------|----------------|-------|-----------|----------|
| Binary Download | ✅ | ❌ | macOS, Linux, Windows | On release |
| Binary Execution | ✅ | ✅ | Current platform | On release / Manual |
| Server Startup | ✅ | ✅ | All | On release / Manual |
| NPM Install | ✅ | ❌ | Linux | On release |
| Docker Pull | ✅ | ❌ | Linux | On release |
| OpenCode Integration | ✅ | ✅ | Linux only | On release / Manual |
| Quick Install | ✅ | ❌ | macOS, Linux | On release |
| Binary Integrity | ❌ | ✅ | Current platform | Manual |

## Test Flow

### Automated (After Release)

```
1. Push git tag (v2.4.4)
   ↓
2. Release workflow builds binaries
   ↓
3. Release workflow creates GitHub Release
   ↓
4. NPM publish workflow publishes to npm
   ↓
5. Docker workflow builds/pushes image
   ↓
6. E2E tests run automatically
   ├── Download binaries from GitHub Release
   ├── Test on all platforms
   ├── Wait for npm package
   ├── Test OpenCode integration
   ├── Test Docker image
   └── Report results
```

### Manual (Before Release)

```
1. Build binary locally
   $ ./build.sh

2. Run local e2e tests
   $ cd web && bun test e2e-release.test.ts

3. Verify all tests pass

4. Create release
   $ ./scripts/create-release.sh 2.4.4

5. Push tag
   $ git push origin v2.4.4

6. Monitor GitHub Actions e2e tests
```

## Environment Variables

The e2e tests use these environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server port for testing | 14456 (local), 13456 (CI) |
| `OPENCODE_PORT` | OpenCode bridge port | 14556 (local), 13556 (CI) |
| `FOSSCLAW_USER` | Auth username | `e2e-test` (local), `test` (CI) |
| `FOSSCLAW_PASS` | Auth password | `e2e-test-123` (local), `test123` (CI) |
| `FOSSCLAW_CWD` | Working directory | `/tmp/fossclaw-e2e-test` |
| `FOSSCLAW_SESSION_DIR` | Session storage | `{FOSSCLAW_CWD}/sessions` |
| `NODE_ENV` | Environment | `production` |

## Debugging Failed E2E Tests

### Binary Download Failures

**Symptoms:** Archive download fails or binary missing

**Check:**
1. Is the release published on GitHub?
2. Are all artifacts uploaded to the release?
3. Is the URL correct in the test?

**Fix:**
```bash
# Check release artifacts
gh release view v2.4.4
gh release download v2.4.4 --dir ./test-artifacts
```

### Server Startup Failures

**Symptoms:** Server process dies or timeout waiting for ready

**Check:**
1. Server logs in GitHub Actions output
2. Port conflicts
3. Missing dependencies in binary

**Debug locally:**
```bash
cd dist
./fossclaw-{platform}-{arch} 2>&1 | tee server.log
```

### NPM Install Failures

**Symptoms:** Package not found or install errors

**Check:**
1. Did npm publish workflow complete?
2. Is package version correct?
3. Is package public on npm?

**Debug:**
```bash
# Check package on npm
npm view fossclaw@2.4.4

# Try manual install
npm install fossclaw@2.4.4
```

### OpenCode Integration Failures

**Symptoms:** `/api/opencode/models` returns errors

**Check:**
1. Is OpenCode installed on test runner?
2. Is OPENCODE_PORT available?
3. Are environment variables set correctly?

**Debug locally:**
```bash
export PORT=13456
export OPENCODE_PORT=13556
./fossclaw-linux-x64

# In another terminal
curl -k https://localhost:13456/api/opencode/models
```

## Adding New E2E Tests

### To GitHub Actions Workflow

1. Add new job to `.github/workflows/e2e-release.yml`:

```yaml
e2e-my-new-test:
  name: E2E - My New Test
  runs-on: ubuntu-latest
  steps:
    - name: Determine release tag
      id: tag
      run: |
        if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
          echo "TAG=${{ inputs.tag }}" >> $GITHUB_OUTPUT
        else
          echo "TAG=${GITHUB_REF#refs/tags/}" >> $GITHUB_OUTPUT
        fi

    - name: Your test steps here
      run: |
        # Test code
```

2. Add to `e2e-results` job needs:

```yaml
needs: [e2e-binary-download, ..., e2e-my-new-test]
```

### To Local Tests

1. Add new test to `web/test/e2e-release.test.ts`:

```typescript
test("my new test", async () => {
  // Test code
  expect(result).toBe(expected);
});
```

2. Run locally:

```bash
cd web
bun test e2e-release.test.ts
```

## CI/CD Integration

The e2e tests are part of the release pipeline:

```
Release Pipeline:
├── 1. release.yml (build binaries)
├── 2. npm-publish.yml (publish to npm)
├── 3. docker.yml (build Docker image)
└── 4. e2e-release.yml (validate everything works)
```

If e2e tests fail, it means the release has issues that need to be fixed. Consider:

1. Yanking the npm package if it's broken
2. Marking the GitHub release as draft
3. Fixing the issue
4. Creating a patch release

## Best Practices

1. **Always run local e2e tests before creating a release**
2. **Monitor GitHub Actions after pushing a tag**
3. **Wait for all e2e tests to pass before announcing release**
4. **Test the installation instructions manually on a clean system**
5. **Keep test timeouts generous** (server startup can be slow in CI)
6. **Use ephemeral ports** to avoid conflicts
7. **Clean up test processes** in `afterAll` hooks

## Troubleshooting

### Tests timeout waiting for server

Increase timeout in test:

```typescript
test("server test", async () => {
  // ...
}, 60000); // 60 second timeout
```

### Binary not found errors

Check that `./build.sh` completed successfully:

```bash
ls -lh dist/
```

### Permission denied executing binary

Make binary executable:

```bash
chmod +x dist/fossclaw-*
```

### Port already in use

Use ephemeral port or different port:

```typescript
const testPort = 14456 + Math.floor(Math.random() * 1000);
```

## Related Documentation

- [Release Process](./RELEASE.md)
- [GitHub Actions](./GITHUB_ACTIONS.md)
- [Contributing](../CONTRIBUTING.md)
