#!/bin/bash
set -e

# Manual Release Script for FossClaw
# Builds for current platform and creates a GitHub release

VERSION=${1:-$(node -p "require('./web/package.json').version")}

if [ -z "$VERSION" ]; then
  echo "Usage: ./release.sh <version>"
  echo "Example: ./release.sh 2.3.0"
  exit 1
fi

echo "Creating release for FossClaw v${VERSION}"
echo "========================================="

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
  echo "❌ GitHub CLI (gh) is not installed."
  echo "Install it from: https://cli.github.com/"
  exit 1
fi

# Check if tag exists
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "⚠️  Tag v${VERSION} already exists."
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 0
  fi
else
  # Create and push tag
  echo "Creating git tag v${VERSION}..."
  git tag -a "v${VERSION}" -m "Release v${VERSION}"
  git push origin "v${VERSION}"
fi

# Build for current platform
echo ""
echo "Building binary for current platform..."
./build.sh "$VERSION"

# Check if dist directory has files
if [ ! "$(ls -A dist)" ]; then
  echo "❌ Build failed - no files in dist/"
  exit 1
fi

# Generate release notes
RELEASE_NOTES_FILE="dist/release_notes.md"
cat > "$RELEASE_NOTES_FILE" << EOF
# FossClaw v${VERSION}

## Changes

EOF

# Extract changelog if exists
if [ -f CHANGELOG.md ]; then
  echo "Extracting changelog..."
  sed -n "/## \[${VERSION}\]/,/## \[/p" CHANGELOG.md | sed '$ d' >> "$RELEASE_NOTES_FILE" || true
fi

# Add installation instructions
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
esac

cat >> "$RELEASE_NOTES_FILE" << EOF

## Installation

This release includes a pre-built binary for **${PLATFORM}-${ARCH}**.

**Note:** To get binaries for other platforms, build on those platforms:
- macOS (ARM64): Build on Apple Silicon Mac
- macOS (x64): Build on Intel Mac or use macOS 13
- Linux (x64): Build on Linux x64 system
- Windows (x64): Build on Windows system

### Download and Run

\`\`\`bash
# Download
curl -L https://github.com/\$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/download/v${VERSION}/fossclaw-v${VERSION}-${PLATFORM}-${ARCH}.tar.gz | tar xz

# Run
./fossclaw-${PLATFORM}-${ARCH}
\`\`\`

### Configuration

Set environment variables:
\`\`\`bash
export PORT=3456                                    # Server port
export FOSSCLAW_CWD=/your/working/directory        # Default working directory
export FOSSCLAW_SESSION_DIR=~/.fossclaw/sessions   # Session storage
export FOSSCLAW_USER=admin                         # Optional: enable auth
export FOSSCLAW_PASS=yourpassword                  # Optional: password
export FOSSCLAW_HTTPS=true                         # Optional: enable HTTPS
export OLLAMA_URL=http://localhost:11434           # Optional: Ollama for auto-naming
\`\`\`

See [README.md](https://github.com/\$(gh repo view --json nameWithOwner -q .nameWithOwner)#readme) for full configuration options.

## Building from Source

\`\`\`bash
git clone https://github.com/\$(gh repo view --json nameWithOwner -q .nameWithOwner).git
cd fossclaw
./build.sh
\`\`\`

## Checksums

\`\`\`
$(cat dist/*.tar.gz.sha256 2>/dev/null || shasum -a 256 dist/*.tar.gz | awk '{print $1}')  fossclaw-v${VERSION}-${PLATFORM}-${ARCH}.tar.gz
\`\`\`
EOF

echo ""
echo "Release notes:"
echo "----------------------------------------"
cat "$RELEASE_NOTES_FILE"
echo "----------------------------------------"
echo ""

read -p "Create GitHub release? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Release cancelled. Build artifacts are in dist/"
  exit 0
fi

# Create GitHub release
echo ""
echo "Creating GitHub release..."

# Check if release already exists
if gh release view "v${VERSION}" &>/dev/null; then
  echo "⚠️  Release v${VERSION} already exists. Adding assets..."
  gh release upload "v${VERSION}" dist/*.tar.gz --clobber
else
  gh release create "v${VERSION}" \
    dist/*.tar.gz \
    --title "FossClaw v${VERSION}" \
    --notes-file "$RELEASE_NOTES_FILE"
fi

echo ""
echo "✅ Release v${VERSION} created successfully!"
echo ""
echo "View release: gh release view v${VERSION} --web"
echo ""
echo "📦 Binaries for other platforms can be built separately and uploaded with:"
echo "   gh release upload v${VERSION} <binary-file>.tar.gz"
