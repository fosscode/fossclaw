import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_FILE = resolve(homedir(), ".fossclaw", "credentials.json");

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Generate a random password
 */
function generatePassword(length = 24): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+";
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length])
    .join("");
}

/**
 * Load or generate credentials
 * - If FOSSCLAW_USER and FOSSCLAW_PASS are set, use those
 * - Otherwise, load from ~/.fossclaw/credentials.json
 * - If file doesn't exist, generate random credentials and save them
 */
export async function ensureCredentials(): Promise<Credentials> {
  // Check environment variables first
  const envUser = process.env.FOSSCLAW_USER;
  const envPass = process.env.FOSSCLAW_PASS;

  if (envUser && envPass) {
    return { username: envUser, password: envPass };
  }

  // Try to load existing credentials
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      const content = await readFile(CREDENTIALS_FILE, "utf-8");
      const credentials = JSON.parse(content) as Credentials;
      if (credentials.username && credentials.password) {
        console.log(`[auth] Loaded existing credentials from ${CREDENTIALS_FILE}`);
        return credentials;
      }
    } catch (error) {
      console.warn(`[auth] Failed to read credentials file, regenerating...`);
    }
  }

  // Generate new credentials
  const credentials: Credentials = {
    username: "admin",
    password: generatePassword(24),
  };

  // Save to disk
  await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), "utf-8");

  console.log(`[auth] Generated new credentials and saved to ${CREDENTIALS_FILE}`);
  console.log(`[auth] Username: ${credentials.username}`);
  console.log(`[auth] Password: ${credentials.password}`);
  console.log(`[auth] IMPORTANT: Save these credentials! They will not be shown again.`);

  return credentials;
}

/**
 * Get the path to the credentials file
 */
export function getCredentialsFilePath(): string {
  return CREDENTIALS_FILE;
}
