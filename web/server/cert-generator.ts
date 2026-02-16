import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

export interface CertPaths {
  cert: string;
  key: string;
}

/**
 * Generate self-signed certificate using openssl
 */
export async function generateSelfSignedCert(
  certDir: string,
  hostname = "localhost"
): Promise<CertPaths> {
  const certPath = resolve(certDir, "cert.pem");
  const keyPath = resolve(certDir, "key.pem");

  // If cert already exists, return it
  if (existsSync(certPath) && existsSync(keyPath)) {
    console.log(`[tls] Using existing certificate at ${certPath}`);
    return { cert: certPath, key: keyPath };
  }

  // Create cert directory if needed
  await mkdir(certDir, { recursive: true });

  console.log(`[tls] Generating self-signed certificate for ${hostname}...`);

  // Generate self-signed cert valid for 365 days
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "365",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${hostname}`,
      "-addext",
      `subjectAltName=DNS:${hostname},DNS:*.${hostname},IP:127.0.0.1`,
    ],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to generate self-signed certificate. Make sure openssl is installed.`
    );
  }

  console.log(`[tls] Certificate generated at ${certPath}`);
  return { cert: certPath, key: keyPath };
}
