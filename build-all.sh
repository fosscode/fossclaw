#!/bin/bash
set -e

# Build FossClaw for all platforms using cross-compilation
# Note: Bun's --compile currently only supports building for the host platform
# For true cross-platform builds, you need to run this on each platform
# or use GitHub Actions (see .github/workflows/release.yml)

VERSION=${1:-$(node -p "require('./web/package.json').version")}

echo "FossClaw v${VERSION} - Cross-Platform Build"
echo "==========================================="
echo ""
echo "⚠️  Note: Bun's --compile only supports building for the current platform."
echo "For cross-platform builds, use GitHub Actions or build on each target platform."
echo ""
echo "Current platform: $(uname -s)-$(uname -m)"
echo ""

read -p "Continue with local build? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  exit 0
fi

./build.sh "$VERSION"

echo ""
echo "To build for other platforms:"
echo "  - Use GitHub Actions: git tag v${VERSION} && git push origin v${VERSION}"
echo "  - Or run this script on each target platform"
