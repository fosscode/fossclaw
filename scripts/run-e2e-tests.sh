#!/bin/bash
set -e

# E2E Release Testing Script
#
# This script builds the FossClaw binary and runs end-to-end tests
# to validate that the release will work correctly for users.
#
# Usage:
#   ./scripts/run-e2e-tests.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🧪 FossClaw E2E Release Testing"
echo "================================"
echo ""

# Check if binary already exists
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
BINARY_NAME="fossclaw-${PLATFORM}-${ARCH}"

if [ "$PLATFORM" = "windows" ]; then
  BINARY_NAME="${BINARY_NAME}.exe"
fi

BINARY_PATH="$PROJECT_ROOT/dist/$BINARY_NAME"

if [ ! -f "$BINARY_PATH" ]; then
  echo "📦 Binary not found at: $BINARY_PATH"
  echo "   Building binary first..."
  echo ""

  cd "$PROJECT_ROOT"

  if [ ! -f "./build.sh" ]; then
    echo "❌ build.sh not found. Are you in the project root?"
    exit 1
  fi

  ./build.sh

  echo ""
  echo "✅ Build complete"
  echo ""
else
  echo "✅ Binary found at: $BINARY_PATH"

  # Show binary info
  SIZE=$(du -h "$BINARY_PATH" | cut -f1)
  echo "   Size: $SIZE"
  echo ""
fi

# Run e2e tests
echo "🧪 Running E2E tests..."
echo ""

cd "$PROJECT_ROOT/web"

if ! command -v bun &> /dev/null; then
  echo "❌ Bun is not installed"
  echo "   Install from: https://bun.sh"
  exit 1
fi

bun test e2e-release.test.ts

echo ""
echo "✅ All E2E tests passed!"
echo ""
echo "Next steps:"
echo "  1. Review test results above"
echo "  2. Create release: ./scripts/create-release.sh <version>"
echo "  3. Push tag: git push origin v<version>"
echo "  4. Monitor GitHub Actions e2e tests"
