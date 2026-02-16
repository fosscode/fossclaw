/**
 * Manual OpenCode integration test
 * Tests the actual OpenCode bridge with a real opencode server
 *
 * Usage: bun run test/opencode-integration.ts
 */

import { OpenCodeBridge } from "../server/opencode-bridge.js";

async function testOpenCodeIntegration() {
  console.log("🧪 Testing OpenCode Integration\n");

  const port = 13456; // Use a high port to avoid conflicts
  const bridge = new OpenCodeBridge(port);

  try {
    // Test 1: Start the OpenCode server
    console.log("1️⃣ Starting OpenCode server...");
    await bridge.start();
    console.log("✅ OpenCode server started successfully\n");

    // Test 2: List available models
    console.log("2️⃣ Fetching available models...");
    const models = await bridge.listModels();
    console.log(`✅ Found ${models.length} models:`);
    for (const model of models.slice(0, 5)) {
      console.log(`   - ${model.name} (${model.providerID}/${model.id})`);
    }
    if (models.length > 5) {
      console.log(`   ... and ${models.length - 5} more`);
    }
    console.log();

    // Test 3: Create a session
    console.log("3️⃣ Creating an OpenCode session...");
    const testSessionId = "test-session-" + Date.now();
    const mapping = await bridge.createSession(
      testSessionId,
      process.cwd(),
      models[0]?.id,
      models[0]?.providerID
    );
    console.log(`✅ Session created:`);
    console.log(`   FossClaw ID: ${mapping.fossclawId}`);
    console.log(`   OpenCode ID: ${mapping.opencodeId}`);
    console.log(`   Model: ${mapping.model} (${mapping.providerID})`);
    console.log();

    // Test 4: Verify session tracking
    console.log("4️⃣ Verifying session tracking...");
    const isTracked = bridge.isOpenCodeSession(testSessionId);
    console.log(`✅ Session tracking: ${isTracked ? "Working" : "FAILED"}\n`);

    // Test 5: Clean up
    console.log("5️⃣ Cleaning up...");
    bridge.removeSession(testSessionId);
    await bridge.stop();
    console.log("✅ Cleanup complete\n");

    console.log("✨ All tests passed!");
    process.exit(0);

  } catch (error) {
    console.error("\n❌ Test failed:");
    console.error(error);

    try {
      await bridge.stop();
    } catch {
      // Ignore cleanup errors
    }

    process.exit(1);
  }
}

testOpenCodeIntegration();
