import { describe, test, expect } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { ensureCredentials, getCredentialsFilePath } from "../server/credential-generator.js";

describe("Credential Generator", () => {
  const credFile = getCredentialsFilePath();

  test("generates credentials when file doesn't exist", async () => {
    // Clear env vars
    const oldUser = process.env.FOSSCLAW_USER;
    const oldPass = process.env.FOSSCLAW_PASS;
    delete process.env.FOSSCLAW_USER;
    delete process.env.FOSSCLAW_PASS;

    // Remove credentials file if it exists
    if (existsSync(credFile)) {
      unlinkSync(credFile);
    }

    const creds = await ensureCredentials();
    expect(creds.username).toBe("admin");
    expect(creds.password).toBeDefined();
    expect(creds.password.length).toBe(24);
    expect(existsSync(credFile)).toBe(true);

    // Clean up
    if (existsSync(credFile)) {
      unlinkSync(credFile);
    }
    if (oldUser) process.env.FOSSCLAW_USER = oldUser;
    if (oldPass) process.env.FOSSCLAW_PASS = oldPass;
  });

  test("loads existing credentials", async () => {
    // Generate first time
    const firstCreds = await ensureCredentials();

    // Load second time (should be same)
    const secondCreds = await ensureCredentials();

    expect(secondCreds.username).toBe(firstCreds.username);
    expect(secondCreds.password).toBe(firstCreds.password);

    // Clean up
    if (existsSync(credFile)) {
      unlinkSync(credFile);
    }
  });

  test("uses environment variables when set", async () => {
    process.env.FOSSCLAW_USER = "testuser";
    process.env.FOSSCLAW_PASS = "testpass123";

    const creds = await ensureCredentials();

    expect(creds.username).toBe("testuser");
    expect(creds.password).toBe("testpass123");

    // Clean up
    delete process.env.FOSSCLAW_USER;
    delete process.env.FOSSCLAW_PASS;
  });

  test("generated password contains valid characters", async () => {
    if (existsSync(credFile)) {
      unlinkSync(credFile);
    }

    const creds = await ensureCredentials();
    const validChars = /^[A-Za-z0-9!@#$%^&*\-_=+]+$/;
    expect(validChars.test(creds.password)).toBe(true);

    // Clean up
    if (existsSync(credFile)) {
      unlinkSync(credFile);
    }
  });
});
