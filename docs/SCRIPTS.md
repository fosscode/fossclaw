# Scripts

Utility scripts for FossClaw development and release management.

## Release Scripts

### `create-release.sh`

Creates a new release by updating version numbers and creating a GPG-signed tag.

```bash
./scripts/create-release.sh 2.4.5
```

**What it does**:
1. Updates version in `package.json` and `web/package.json`
2. Creates version bump commit
3. Creates GPG-signed tag `v<version>`
4. Provides instructions for pushing

**See**: [docs/RELEASE.md](../docs/RELEASE.md)

---

### `run-e2e-tests.sh`

Runs end-to-end tests on the built binary before releasing.

```bash
./scripts/run-e2e-tests.sh
```

**What it does**:
1. Checks if binary exists, builds if needed
2. Runs comprehensive e2e test suite
3. Validates binary integrity, size, functionality
4. Tests server startup and API endpoints

**Requirements**:
- Bun installed
- Run from project root or scripts directory

**See**: [docs/E2E_TESTING.md](../docs/E2E_TESTING.md)

---

## Workflow

Recommended release workflow:

```bash
# 1. Run local e2e tests
./scripts/run-e2e-tests.sh

# 2. Create release
./scripts/create-release.sh 2.4.5

# 3. Push to GitHub
git push origin main
git push origin v2.4.5

# 4. Monitor GitHub Actions
# - Release workflow builds binaries
# - NPM publish workflow publishes package
# - Docker workflow builds images
# - E2E workflow validates everything
```

---

## Other Scripts

### Hook Scripts

Located in `.githooks/`:
- `pre-commit` - Validates commits, prevents secrets
- `pre-push` - Runs tests, type checks, security checks

Install with:
```bash
./setup-hooks.sh
```

---

## Documentation

- [Release Process](../docs/RELEASE.md)
- [E2E Testing](../docs/E2E_TESTING.md)
- [GitHub Actions](../docs/GITHUB_ACTIONS.md)
- [Contributing](../CONTRIBUTING.md)
