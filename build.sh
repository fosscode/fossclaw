#!/bin/bash
set -e

# FossClaw Build Script
# Builds standalone binaries for multiple platforms

VERSION=${1:-$(node -p "require('./web/package.json').version")}
BUILD_DIR="build"
DIST_DIR="dist"

echo "Building FossClaw v${VERSION}"

# Clean previous builds
rm -rf "$BUILD_DIR" "$DIST_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

# Build frontend first
echo "Building frontend..."
cd web
bun install
bun run build
cd ..

# Create a bundled entry point
cat > "$BUILD_DIR/entry.ts" << 'EOF'
#!/usr/bin/env bun
// FossClaw Standalone Entry Point
process.env.__FOSSCLAW_PACKAGE_ROOT = import.meta.dir;
import "./server/index.ts";
EOF

# Copy necessary files to build directory
echo "Copying server files..."
cp -r web/server "$BUILD_DIR/"
cp -r web/dist "$BUILD_DIR/"
cp web/package.json "$BUILD_DIR/"
cp LICENSE "$BUILD_DIR/" 2>/dev/null || true
cp README.md "$BUILD_DIR/" 2>/dev/null || true

# Install production dependencies in build directory
echo "Installing production dependencies..."
cd "$BUILD_DIR"
bun install --production
cd ..

# Build for current platform
CURRENT_PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
CURRENT_ARCH=$(uname -m)

case "$CURRENT_ARCH" in
  x86_64) CURRENT_ARCH="x64" ;;
  arm64|aarch64) CURRENT_ARCH="arm64" ;;
esac

echo "Building for current platform: ${CURRENT_PLATFORM}-${CURRENT_ARCH}"

cd "$BUILD_DIR"

# Build binary
if [ "$CURRENT_PLATFORM" = "darwin" ]; then
  bun build entry.ts --compile --target=bun --outfile "../${DIST_DIR}/fossclaw-darwin-${CURRENT_ARCH}"
  chmod +x "../${DIST_DIR}/fossclaw-darwin-${CURRENT_ARCH}"

  # Create tarball
  tar -czf "../${DIST_DIR}/fossclaw-v${VERSION}-darwin-${CURRENT_ARCH}.tar.gz" \
    -C "../${DIST_DIR}" "fossclaw-darwin-${CURRENT_ARCH}"

  echo "✓ Built: fossclaw-v${VERSION}-darwin-${CURRENT_ARCH}.tar.gz"
elif [ "$CURRENT_PLATFORM" = "linux" ]; then
  bun build entry.ts --compile --target=bun --outfile "../${DIST_DIR}/fossclaw-linux-${CURRENT_ARCH}"
  chmod +x "../${DIST_DIR}/fossclaw-linux-${CURRENT_ARCH}"

  # Create tarball
  tar -czf "../${DIST_DIR}/fossclaw-v${VERSION}-linux-${CURRENT_ARCH}.tar.gz" \
    -C "../${DIST_DIR}" "fossclaw-linux-${CURRENT_ARCH}"

  echo "✓ Built: fossclaw-v${VERSION}-linux-${CURRENT_ARCH}.tar.gz"
else
  echo "Unsupported platform: $CURRENT_PLATFORM"
  exit 1
fi

cd ..

# Show build artifacts
echo ""
echo "Build complete! Artifacts in ${DIST_DIR}/:"
ls -lh "${DIST_DIR}/"

# Show checksums
echo ""
echo "SHA256 checksums:"
shasum -a 256 "${DIST_DIR}"/*.tar.gz | sed 's|'${DIST_DIR}'/||'
