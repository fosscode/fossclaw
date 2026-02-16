import { describe, expect, test } from "bun:test";
import { OllamaClient } from "../server/ollama-client.js";

describe("Ollama Session Naming", () => {
  // These tests require a running Ollama instance
  // Skip if OLLAMA_URL is not set
  const ollamaUrl = process.env.OLLAMA_URL;
  const shouldRun = !!ollamaUrl;

  test.skipIf(!shouldRun)("should generate a session name from user message", async () => {
    const client = new OllamaClient(ollamaUrl);
    const isAvailable = await client.isAvailable();

    if (!isAvailable) {
      console.log("⚠️  Ollama not available, skipping test");
      return;
    }

    const name = await client.generateSessionName(
      "Can you help me refactor this React component to use TypeScript?"
    );

    expect(name).toBeTruthy();
    expect(name!.length).toBeGreaterThan(0);
    expect(name!.length).toBeLessThan(50);
    console.log(`Generated name: "${name}"`);
  });

  test.skipIf(!shouldRun)("should handle various message types", async () => {
    const client = new OllamaClient(ollamaUrl);
    const isAvailable = await client.isAvailable();

    if (!isAvailable) {
      console.log("⚠️  Ollama not available, skipping test");
      return;
    }

    const messages = [
      "Fix the login bug",
      "Add dark mode to the dashboard",
      "Write unit tests for the API endpoints",
      "Optimize database queries for performance",
    ];

    for (const msg of messages) {
      const name = await client.generateSessionName(msg);
      expect(name).toBeTruthy();
      console.log(`"${msg}" -> "${name}"`);
    }
  });

  test("should return null if Ollama is not available", async () => {
    const client = new OllamaClient("http://localhost:99999");
    const name = await client.generateSessionName("test message");
    expect(name).toBeNull();
  });
});
