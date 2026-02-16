#!/bin/bash
# Run FossClaw E2E tests in a clean environment (without auth)

set -e

cd "$(dirname "$0")/web"

echo "🧪 Running FossClaw E2E Tests"
echo "=============================="
echo ""
echo "📝 Note: Running tests without authentication enabled"
echo ""

# Unset auth variables and run tests
env -u FOSSCLAW_USER -u FOSSCLAW_PASS bun test e2e-ui.test.ts

echo ""
echo "✨ Tests complete! See E2E_TEST_RESULTS.md for details."
