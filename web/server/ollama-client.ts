/**
 * Ollama client for generating session names based on user input.
 * Uses the Ollama API to generate concise, descriptive session titles.
 */

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: {
    temperature?: number;
    max_tokens?: number;
  };
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

export class OllamaClient {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = baseUrl || process.env.OLLAMA_URL || "http://localhost:11434";
    // Remove trailing slash if present
    this.baseUrl = this.baseUrl.replace(/\/$/, "");
    this.model = model || process.env.OLLAMA_MODEL || "llama3.2:3b";
  }

  /**
   * Generate a concise session name (3-5 words) based on user input.
   */
  async generateSessionName(userMessage: string): Promise<string | null> {
    try {
      const prompt = `Given this user message, generate a very short, concise session name (3-5 words maximum, no quotes or punctuation):

User message: ${userMessage.substring(0, 200)}

Session name:`;

      const request: OllamaGenerateRequest = {
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          max_tokens: 20,
        },
      };

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        console.error(`[ollama] Failed to generate session name: ${response.status} ${response.statusText}`);
        return null;
      }

      const data: OllamaGenerateResponse = await response.json();

      // Clean up the response: trim, remove quotes, limit length
      let name = data.response.trim();
      name = name.replace(/^["']|["']$/g, ""); // Remove surrounding quotes
      name = name.split("\n")[0]; // Take only first line
      name = name.substring(0, 50); // Max 50 chars

      if (name.length === 0) {
        return null;
      }

      console.log(`[ollama] Generated session name: "${name}" for message: "${userMessage.substring(0, 50)}..."`);
      return name;
    } catch (error) {
      console.error(`[ollama] Error generating session name:`, error);
      return null;
    }
  }

  /**
   * Check if Ollama is available and the model is loaded.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return false;

      const data = await response.json();
      const models = data.models as { name: string }[];

      // Check if our model exists
      const modelExists = models.some((m) => m.name === this.model);
      if (!modelExists) {
        console.warn(`[ollama] Model "${this.model}" not found. Available models:`, models.map((m) => m.name).join(", "));
      }

      return modelExists;
    } catch {
      return false;
    }
  }
}
