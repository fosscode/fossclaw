#!/bin/bash
# Test script to verify OpenCode SSE connection is working

set -e

echo "🧪 OpenCode SSE Connection Test"
echo "================================"
echo ""

# Check if OpenCode is available
if ! command -v opencode &> /dev/null; then
    echo "❌ OpenCode not found. Please install it first."
    exit 1
fi

OPENCODE_PORT=13500

echo "1️⃣ Starting OpenCode test server on port $OPENCODE_PORT..."
opencode serve --port $OPENCODE_PORT > /tmp/opencode-test-server.log 2>&1 &
OPENCODE_PID=$!

# Wait for server to start
sleep 2

# Check if server is healthy
if ! curl -s http://localhost:$OPENCODE_PORT/global/health > /dev/null 2>&1; then
    echo "❌ OpenCode server failed to start"
    kill $OPENCODE_PID 2>/dev/null
    exit 1
fi

echo "   ✅ OpenCode server started (PID $OPENCODE_PID)"
echo ""

echo "2️⃣ Testing SSE endpoint..."
# Try to connect to SSE and capture first event
TIMEOUT=5
SSE_OUTPUT=$(timeout $TIMEOUT curl -N -H "Accept: text/event-stream" http://localhost:$OPENCODE_PORT/event 2>/dev/null | head -1)

if echo "$SSE_OUTPUT" | grep -q "server.connected"; then
    echo "   ✅ SSE endpoint responding correctly"
    echo "   📡 First event: $SSE_OUTPUT"
else
    echo "   ❌ SSE endpoint not responding as expected"
    echo "   Got: $SSE_OUTPUT"
    kill $OPENCODE_PID 2>/dev/null
    exit 1
fi

echo ""
echo "3️⃣ Cleaning up..."
kill $OPENCODE_PID 2>/dev/null
wait $OPENCODE_PID 2>/dev/null
echo "   ✅ Test server stopped"

echo ""
echo "✨ OpenCode SSE endpoint is working!"
echo ""
echo "📝 Next steps:"
echo "   1. Restart your FossClaw server: cd web && bun run dev"
echo "   2. Watch logs for: [opencode] SSE connection established"
echo "   3. Create an OpenCode session and send a message"
echo "   4. Verify you see: [opencode] SSE event: message.updated"
