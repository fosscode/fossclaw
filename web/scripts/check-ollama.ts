#!/usr/bin/env bun
/**
 * Check if Ollama is available and list available models.
 * Usage: bun scripts/check-ollama.ts [ollama-url]
 */

const url = process.argv[2] || process.env.OLLAMA_URL || "http://localhost:11434";

console.log(`\n🔍 Checking Ollama at: ${url}\n`);

try {
  const response = await fetch(`${url}/api/tags`);

  if (!response.ok) {
    console.error(`❌ Failed to connect: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const data = await response.json();
  const models = data.models as { name: string; size: number; modified_at: string }[];

  if (models.length === 0) {
    console.log("⚠️  No models found on this Ollama instance");
    process.exit(0);
  }

  console.log(`✅ Found ${models.length} model(s):\n`);

  // Group models by family
  const families = new Map<string, typeof models>();
  for (const model of models) {
    const family = model.name.split(":")[0];
    if (!families.has(family)) {
      families.set(family, []);
    }
    families.get(family)!.push(model);
  }

  for (const [family, familyModels] of families) {
    console.log(`  ${family}:`);
    for (const model of familyModels) {
      const sizeGB = (model.size / 1024 / 1024 / 1024).toFixed(1);
      const recommended = model.name === "llama3.2:3b" ? " ⭐ (recommended)" : "";
      console.log(`    - ${model.name} (${sizeGB} GB)${recommended}`);
    }
    console.log("");
  }

  console.log("To use a specific model, set:\n");
  console.log(`  export OLLAMA_URL=${url}`);
  console.log(`  export OLLAMA_MODEL=llama3.2:3b  # or any model from above\n`);
} catch (error) {
  console.error(`❌ Failed to connect to Ollama: ${error instanceof Error ? error.message : error}`);
  console.log(`\nMake sure Ollama is running at ${url}\n`);
  process.exit(1);
}
