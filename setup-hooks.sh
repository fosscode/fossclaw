#!/bin/bash
# Setup git hooks for FossClaw development

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== FossClaw Git Hooks Setup ===${NC}"
echo ""

# Check if we're in a git repo
if [ ! -d ".git" ]; then
  echo "Error: Not in a git repository root"
  exit 1
fi

# Create hooks directory if it doesn't exist
mkdir -p .git/hooks

# Create pre-push hook
cat > .git/hooks/pre-push << 'HOOK_EOF'
#!/bin/bash
# Pre-push hook: Security checks, author rewriting, tests, and linting

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== FossClaw Pre-Push Checks ===${NC}"
echo ""

# ============================================================================
# CHECK 1: Secrets Detection
# ============================================================================
echo -e "${YELLOW}[1/5] Checking for secrets and sensitive data...${NC}"

# Patterns to detect secrets
SECRET_PATTERNS=(
  "password\s*=\s*['\"][^'\"]{3,}"
  "api[_-]?key\s*=\s*['\"][^'\"]{10,}"
  "secret\s*=\s*['\"][^'\"]{10,}"
  "token\s*=\s*['\"][^'\"]{10,}"
  "bearer\s+[a-zA-Z0-9_\-]{20,}"
  "AKIA[0-9A-Z]{16}"
  "AIza[0-9A-Za-z_\-]{35}"
  "sk-[a-zA-Z0-9]{32,}"
  "ghp_[a-zA-Z0-9]{36}"
  "gho_[a-zA-Z0-9]{36}"
  "-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----"
  "mongodb(\+srv)?://[^\s]{10,}"
  "postgres://[^\s]{10,}"
  "mysql://[^\s]{10,}"
)

# Files that should never be committed
FORBIDDEN_FILES=(
  "*.pem"
  "*.key"
  "*.p12"
  "*.pfx"
  ".env"
  "id_rsa"
  "id_dsa"
  "credentials.json"
  "auth.json"
)

# Check for forbidden files
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    range="$local_sha"
  else
    range="$remote_sha..$local_sha"
  fi

  # Check each forbidden file pattern
  for pattern in "${FORBIDDEN_FILES[@]}"; do
    forbidden=$(git diff --name-only "$range" | grep -E "$pattern" || true)
    if [ -n "$forbidden" ]; then
      echo -e "${RED}⚠ FORBIDDEN FILE DETECTED:${NC}"
      echo "$forbidden"
      echo ""
      echo -e "${RED}Aborting push. Remove sensitive files before pushing.${NC}"
      exit 1
    fi
  done

  # Check for secret patterns in diff
  for pattern in "${SECRET_PATTERNS[@]}"; do
    secrets=$(git diff "$range" | grep -iE "$pattern" || true)
    if [ -n "$secrets" ]; then
      echo -e "${RED}⚠ POTENTIAL SECRET DETECTED:${NC}"
      echo "$secrets" | head -5
      echo ""
      echo -e "${RED}Aborting push. Review and remove secrets before pushing.${NC}"
      exit 1
    fi
  done
done

echo -e "${GREEN}✓ No secrets detected${NC}"
echo ""

# ============================================================================
# CHECK 2: .gitignore Validation
# ============================================================================
echo -e "${YELLOW}[2/5] Validating .gitignore...${NC}"

REQUIRED_GITIGNORE=(
  "^.env$"
  "^\\.env\\.\\*$"
  "^\\*\\.log$"
  "^node_modules/"
  "^\\.DS_Store$"
)

for pattern in "${REQUIRED_GITIGNORE[@]}"; do
  if ! grep -qE "$pattern" .gitignore 2>/dev/null; then
    echo -e "${RED}⚠ Missing required .gitignore pattern: $pattern${NC}"
    exit 1
  fi
done

if grep -qE "^!\.env$" .gitignore 2>/dev/null; then
  echo -e "${RED}⚠ .gitignore allows .env files (dangerous!)${NC}"
  exit 1
fi

echo -e "${GREEN}✓ .gitignore is valid${NC}"
echo ""

# ============================================================================
# CHECK 3: Claude Author Rewriting
# ============================================================================
echo -e "${YELLOW}[3/5] Checking commit authorship...${NC}"

FOSSCODE_NAME="FossCode"
FOSSCODE_EMAIL="noreply@fosscode.org"

CLAUDE_PATTERNS=(
  "Claude Sonnet"
  "noreply@anthropic.com"
  "claude-sonnet"
)

while read local_ref local_sha remote_ref remote_sha; do
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    range="$local_sha"
  else
    range="$remote_sha..$local_sha"
  fi

  claude_commits=$(git log --format="%H %an %ae" "$range" | grep -iE "$(IFS="|"; echo "${CLAUDE_PATTERNS[*]}")" || true)

  if [ -n "$claude_commits" ]; then
    echo -e "${YELLOW}Found commits with Claude authorship - rewriting...${NC}"

    filter_script=$(cat <<'EOF'
FOSSCODE_NAME="FossCode"
FOSSCODE_EMAIL="noreply@fosscode.org"

if echo "$GIT_AUTHOR_EMAIL" | grep -qiE "anthropic\.com|claude"; then
  export GIT_AUTHOR_NAME="$FOSSCODE_NAME"
  export GIT_AUTHOR_EMAIL="$FOSSCODE_EMAIL"
fi

if echo "$GIT_COMMITTER_EMAIL" | grep -qiE "anthropic\.com|claude"; then
  export GIT_COMMITTER_NAME="$FOSSCODE_NAME"
  export GIT_COMMITTER_EMAIL="$FOSSCODE_EMAIL"
fi

if echo "$GIT_AUTHOR_NAME" | grep -qiE "claude|sonnet"; then
  export GIT_AUTHOR_NAME="$FOSSCODE_NAME"
  export GIT_AUTHOR_EMAIL="$FOSSCODE_EMAIL"
fi

if echo "$GIT_COMMITTER_NAME" | grep -qiE "claude|sonnet"; then
  export GIT_COMMITTER_NAME="$FOSSCODE_NAME"
  export GIT_COMMITTER_EMAIL="$FOSSCODE_EMAIL"
fi
EOF
)

    if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
      git filter-branch -f --env-filter "$filter_script" HEAD 2>/dev/null
    else
      git filter-branch -f --env-filter "$filter_script" "$remote_sha..HEAD" 2>/dev/null
    fi

    remaining=$(git log --format="%H %an %ae" "$range" | grep -iE "$(IFS="|"; echo "${CLAUDE_PATTERNS[*]}")" || true)
    if [ -n "$remaining" ]; then
      echo -e "${RED}⚠ Failed to rewrite all Claude commits${NC}"
      exit 1
    fi

    echo -e "${GREEN}✓ Commits rewritten to FossCode authorship${NC}"
  else
    echo -e "${GREEN}✓ All commits use proper authorship${NC}"
  fi
done
echo ""

# ============================================================================
# CHECK 4: Type Checking & Linting
# ============================================================================
echo -e "${YELLOW}[4/5] Running type checks and linting...${NC}"

cd web

if ! command -v bun &> /dev/null; then
  echo -e "${RED}⚠ Bun not found. Skipping type checks and linting.${NC}"
else
  echo -e "  ${BLUE}Running TypeScript type checks...${NC}"
  if ! bun run tsc --noEmit 2>/dev/null; then
    echo -e "${RED}⚠ Type check failed${NC}"
    exit 1
  fi
  echo -e "  ${GREEN}✓ Type checks passed${NC}"

  if grep -q '"lint"' package.json 2>/dev/null; then
    echo -e "  ${BLUE}Running linter...${NC}"
    if ! bun run lint 2>/dev/null; then
      echo -e "${RED}⚠ Linting failed${NC}"
      exit 1
    fi
    echo -e "  ${GREEN}✓ Linting passed${NC}"
  fi
fi

cd ..
echo ""

# ============================================================================
# CHECK 5: Unit Tests
# ============================================================================
echo -e "${YELLOW}[5/5] Running tests...${NC}"

cd web

if ! command -v bun &> /dev/null; then
  echo -e "${RED}⚠ Bun not found. Skipping tests.${NC}"
else
  if ! bun test 2>&1 | tee /tmp/fossclaw-test-output.log; then
    echo -e "${RED}⚠ Tests failed${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ All tests passed${NC}"
fi

cd ..
echo ""

# ============================================================================
# Summary
# ============================================================================
echo -e "${GREEN}=== All Pre-Push Checks Passed ===${NC}"
echo -e "${GREEN}✓ No secrets detected${NC}"
echo -e "${GREEN}✓ .gitignore is valid${NC}"
echo -e "${GREEN}✓ Commit authorship is correct${NC}"
echo -e "${GREEN}✓ Type checks passed${NC}"
echo -e "${GREEN}✓ Tests passed${NC}"
echo ""
echo -e "${BLUE}Proceeding with push...${NC}"

exit 0
HOOK_EOF

# Make hook executable
chmod +x .git/hooks/pre-push

echo -e "${GREEN}✓ Pre-push hook installed${NC}"
echo ""
echo -e "${BLUE}The hook will run automatically on every 'git push'${NC}"
echo -e "${BLUE}To bypass (not recommended): git push --no-verify${NC}"
