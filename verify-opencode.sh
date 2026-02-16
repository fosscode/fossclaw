#!/bin/bash
# Quick verification script to check OpenCode integration readiness

set -e

echo "🔍 FossClaw OpenCode Integration Checker"
echo "========================================"
echo ""

# Check 1: OpenCode binary
echo "1️⃣ Checking OpenCode installation..."
if command -v opencode &> /dev/null; then
    OPENCODE_PATH=$(which opencode)
    OPENCODE_VERSION=$(opencode --version 2>&1 | head -n1 || echo "unknown")
    echo "   ✅ OpenCode found at: $OPENCODE_PATH"
    echo "   📦 Version: $OPENCODE_VERSION"
else
    echo "   ❌ OpenCode not found in PATH"
    echo "   💡 Install with: brew install opencode"
    exit 1
fi
echo ""

# Check 2: OpenCode configuration
echo "2️⃣ Checking OpenCode configuration..."
if opencode config providers &> /dev/null; then
    PROVIDER_COUNT=$(opencode config providers 2>/dev/null | grep -c "id:" || echo "0")
    echo "   ✅ OpenCode is configured"
    echo "   📊 Found $PROVIDER_COUNT provider(s)"

    # Show providers
    echo "   🔧 Configured providers:"
    opencode config providers 2>/dev/null | grep -E "(id:|name:)" | sed 's/^/      /' || echo "      (none)"
else
    echo "   ⚠️  OpenCode configuration may be incomplete"
    echo "   💡 Run: opencode config"
fi
echo ""

# Check 3: Port availability
echo "3️⃣ Checking port availability..."
DEFAULT_PORT=3556
if lsof -i :$DEFAULT_PORT &> /dev/null; then
    echo "   ⚠️  Port $DEFAULT_PORT is in use"
    echo "   🔍 Process using port:"
    lsof -i :$DEFAULT_PORT | sed 's/^/      /'
    echo "   💡 Set OPENCODE_PORT to use a different port"
else
    echo "   ✅ Port $DEFAULT_PORT is available"
fi
echo ""

# Check 4: Test starting OpenCode server
echo "4️⃣ Testing OpenCode server startup..."
echo "   🚀 Starting test server on port 13456..."

# Start server in background
opencode serve --port 13456 > /tmp/opencode-test.log 2>&1 &
OPENCODE_PID=$!

# Wait for server to start (max 10 seconds)
for i in {1..10}; do
    if curl -s http://localhost:13456/global/health > /dev/null 2>&1; then
        echo "   ✅ OpenCode server started successfully (${i}s)"

        # Test health endpoint
        HEALTH_STATUS=$(curl -s http://localhost:13456/global/health)
        echo "   🏥 Health check: $HEALTH_STATUS"

        # Test providers endpoint
        echo "   📡 Testing API endpoints..."
        if curl -s http://localhost:13456/config/providers > /dev/null 2>&1; then
            MODEL_COUNT=$(curl -s http://localhost:13456/config/providers | grep -c '"id"' || echo "0")
            echo "   ✅ API responding (found ~$MODEL_COUNT model entries)"
        else
            echo "   ⚠️  API endpoints not responding"
        fi

        # Clean up
        kill $OPENCODE_PID 2>/dev/null
        wait $OPENCODE_PID 2>/dev/null
        echo "   🧹 Test server stopped"
        break
    fi

    # Check if process died
    if ! kill -0 $OPENCODE_PID 2>/dev/null; then
        echo "   ❌ OpenCode server exited prematurely"
        echo "   📋 Server logs:"
        cat /tmp/opencode-test.log | sed 's/^/      /'
        exit 1
    fi

    sleep 1
done

# Check if we timed out
if ! curl -s http://localhost:13456/global/health > /dev/null 2>&1; then
    echo "   ❌ Server did not start within 10 seconds"
    echo "   📋 Server logs:"
    cat /tmp/opencode-test.log | sed 's/^/      /'
    kill $OPENCODE_PID 2>/dev/null
    wait $OPENCODE_PID 2>/dev/null
    exit 1
fi

echo ""

# Check 5: Verify FossClaw files
echo "5️⃣ Checking FossClaw OpenCode integration files..."
REQUIRED_FILES=(
    "web/server/opencode-bridge.ts"
    "web/server/cli-launcher.ts"
    "web/server/index.ts"
)

ALL_EXIST=true
for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "   ✅ $file"
    else
        echo "   ❌ $file (missing)"
        ALL_EXIST=false
    fi
done

if [ "$ALL_EXIST" = false ]; then
    echo ""
    echo "   ⚠️  Some required files are missing"
    exit 1
fi
echo ""

# Summary
echo "🎉 Summary"
echo "=========="
echo "OpenCode is properly installed and configured."
echo "The integration should work when you start FossClaw."
echo ""
echo "📚 Next steps:"
echo "   1. Start FossClaw: cd web && bun run dev"
echo "   2. Open UI: http://localhost:5174"
echo "   3. Select 'OpenCode' as provider"
echo "   4. Choose a model and start chatting"
echo ""
echo "📖 For detailed testing guide, see: OPENCODE_TEST_GUIDE.md"
echo "🧪 For manual integration test: cd web && bun test/opencode-integration.ts"
