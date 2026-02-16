#!/bin/bash
set -e

# FossClaw Release Helper
# Creates a new release with GPG-signed tag
# Usage: ./scripts/create-release.sh <version>

if [ -z "$1" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

VERSION=$1
TAG="v${VERSION}"

# Color output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Creating release ${TAG}${NC}"

# Check if working directory is clean
if [[ -n $(git status --porcelain) ]]; then
  echo -e "${RED}Error: Working directory is not clean. Commit or stash your changes.${NC}"
  exit 1
fi

# Check if we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo -e "${YELLOW}Warning: You are on branch '${CURRENT_BRANCH}', not 'main'${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo -e "${RED}Error: Tag ${TAG} already exists${NC}"
  exit 1
fi

# Update version in web/package.json
echo -e "${GREEN}Updating version in web/package.json...${NC}"
cd web
npm version "$VERSION" --no-git-tag-version --allow-same-version
cd ..

# Update version in root package.json
echo -e "${GREEN}Updating version in package.json...${NC}"
npm version "$VERSION" --no-git-tag-version --allow-same-version

# Commit version bump
echo -e "${GREEN}Committing version bump...${NC}"
git add package.json web/package.json
git commit -m "chore: bump version to ${VERSION}"

# Create GPG-signed tag
echo -e "${GREEN}Creating GPG-signed tag ${TAG}...${NC}"
git tag -s "$TAG" -m "Release ${TAG}"

# Verify signature
echo -e "${GREEN}Verifying GPG signature...${NC}"
git tag -v "$TAG"

echo ""
echo -e "${GREEN}✓ Release ${TAG} prepared successfully!${NC}"
echo ""
echo "Next steps:"
echo "  1. Review the changes:"
echo "     git show ${TAG}"
echo ""
echo "  2. Push the tag to trigger release workflow:"
echo "     git push origin main"
echo "     git push origin ${TAG}"
echo ""
echo "  3. GitHub Actions will automatically build binaries for:"
echo "     - macOS (Apple Silicon & Intel)"
echo "     - Linux (x64 & ARM64)"
echo "     - Windows (x64)"
echo ""
echo "  4. Edit release notes at:"
echo "     https://github.com/$(git config --get remote.origin.url | sed 's/.*github.com[:\/]\(.*\)\.git/\1/')/releases/tag/${TAG}"
