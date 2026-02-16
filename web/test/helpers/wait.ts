/** Poll until `fn` returns true, or throw after `timeoutMs`. */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Simple async delay. */
export function delay(ms: number): Promise<void> {
  return Bun.sleep(ms);
}
