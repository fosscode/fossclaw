/**
 * Smart session namer that extracts a meaningful name from user messages.
 * No LLM required — uses text heuristics to pull out the key topic/intent.
 */

// Common filler/stop words to strip
const STOP_WORDS = new Set([
  // articles & determiners
  "a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her", "its",
  "our", "their", "some", "any", "each", "every", "all", "both", "few", "more", "most",
  // pronouns
  "i", "me", "we", "us", "you", "he", "him", "she", "it", "they", "them",
  "what", "which", "who", "whom", "whose",
  // prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about", "into",
  "through", "during", "before", "after", "above", "below", "between", "under", "over",
  // conjunctions
  "and", "but", "or", "nor", "so", "yet", "as", "if", "then", "than", "when", "while",
  // common verbs (too generic)
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "having",
  "do", "does", "did", "doing", "will", "would", "could", "should", "may", "might",
  "shall", "can", "must", "need", "dare", "let", "get", "got", "getting",
  // filler
  "just", "also", "very", "really", "actually", "basically", "literally", "maybe",
  "please", "thanks", "thank", "hey", "hi", "hello", "ok", "okay", "sure", "yeah",
  "well", "like", "know", "think", "want", "going", "thing", "things", "stuff",
  "something", "anything", "everything", "nothing", "way", "much", "many",
  "here", "there", "where", "how", "why", "not", "no", "yes",
  // Claude-specific filler
  "can", "could", "would", "help", "me", "make", "take", "see", "try",
  "using", "working", "running", "go", "give", "put",
  "seem", "come", "keep", "still", "even", "back", "only", "now",
  "able", "lot", "bit", "kind", "sort", "type",
]);

// Action verbs that are meaningful and should be kept (they indicate intent)
const MEANINGFUL_VERBS = new Set([
  "fix", "add", "create", "build", "implement", "update", "change", "modify",
  "remove", "delete", "refactor", "optimize", "debug", "test", "deploy",
  "configure", "setup", "install", "migrate", "upgrade", "convert",
  "write", "rewrite", "rename", "move", "copy", "merge", "split",
  "enable", "disable", "integrate", "connect", "disconnect",
  "import", "export", "parse", "format", "validate", "verify",
  "analyze", "review", "audit", "monitor", "log", "track",
  "encrypt", "decrypt", "authenticate", "authorize",
  "search", "filter", "sort", "group", "paginate",
  "cache", "index", "compress", "minify", "bundle",
  "lint", "prettify", "clean", "reset", "restore",
  "scaffold", "bootstrap", "generate", "template",
]);

/**
 * Extract a concise, meaningful session name from user message text.
 * Returns a 2-6 word title-cased name.
 */
export function extractSessionName(message: string): string {
  // Strip markdown formatting, code blocks, URLs
  let text = message
    .replace(/```[\s\S]*?```/g, " [code] ")        // code blocks → placeholder
    .replace(/`[^`]+`/g, " [code] ")                // inline code → placeholder
    .replace(/https?:\/\/\S+/g, "")                  // URLs
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")         // markdown links → text
    .replace(/[#*_~>|]/g, "")                         // markdown symbols
    .replace(/\n+/g, " ")                             // newlines → spaces
    .trim();

  // If mostly code, just say so
  const codeCount = (text.match(/\[code\]/g) || []).length;
  if (codeCount > 0 && text.replace(/\[code\]/g, "").trim().length < 20) {
    return "Code Review";
  }

  // Take first ~200 chars (first sentence or two is usually most informative)
  text = text.substring(0, 200);

  // Try to get the first sentence — but don't split on dots in filenames (e.g. foo.ts)
  const firstSentence = text.match(/^(?:(?!\.\s)[^!?\n])+[.!?]?/)?.[0] || text;
  const workingText = firstSentence.length > 10 ? firstSentence : text;

  // Tokenize: split on whitespace and punctuation, keep hyphenated words and filenames
  const rawTokens = workingText
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.\/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Separate into action verbs and content words
  const actionVerbs: string[] = [];
  const contentWords: string[] = [];

  for (const token of rawTokens) {
    // Skip very short tokens and stop words
    if (token.length <= 1) continue;
    if (token === "[code]") continue;

    // Keep file paths and technical terms as-is
    if (token.includes("/") || token.includes("_")) {
      const parts = token.split("/");
      const filename = parts[parts.length - 1];
      if (filename.length > 2) {
        contentWords.push(filename);
      }
      continue;
    }

    // Keep filenames with extensions (e.g. "foo.ts", "README.md")
    if (token.includes(".") && /\.[a-z]{1,4}$/.test(token)) {
      contentWords.push(token);
      continue;
    }

    // Strip trailing periods from regular words
    const cleaned = token.replace(/\.$/, "");
    if (cleaned.length <= 1) continue;

    if (MEANINGFUL_VERBS.has(cleaned)) {
      actionVerbs.push(cleaned);
    } else if (!STOP_WORDS.has(cleaned) && cleaned.length > 2) {
      contentWords.push(cleaned);
    }
  }

  // Build the name: prefer "verb + subject" pattern
  const parts: string[] = [];

  // Pick the first action verb if available
  if (actionVerbs.length > 0) {
    parts.push(actionVerbs[0]);
  }

  // Add up to 4 content words
  const remaining = 5 - parts.length;
  for (let i = 0; i < Math.min(remaining, contentWords.length); i++) {
    // Skip duplicates
    if (!parts.includes(contentWords[i])) {
      parts.push(contentWords[i]);
    }
  }

  // If we got nothing useful or too little, fall back
  if (parts.length === 0 || (parts.length === 1 && parts[0].length <= 4)) {
    // Try to salvage from the raw first few words (skip stop words)
    const fallback = rawTokens
      .filter((t) => t.length > 2 && t !== "[code]")
      .slice(0, 4);
    if (fallback.length > 1) {
      return titleCase(fallback.join(" ")).substring(0, 50);
    }
    return "New Chat";
  }

  // Title-case and join
  const name = titleCase(parts.join(" "));

  // Trim to 50 chars max
  return name.substring(0, 50);
}

/**
 * Title-case a string: capitalize first letter of each word.
 * Preserves technical terms like filenames (foo.ts stays foo.ts).
 */
function titleCase(str: string): string {
  return str
    .split(" ")
    .map((word) => {
      // Don't title-case things that look like filenames or paths
      if (word.includes(".") || word.includes("/") || word.includes("_")) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}
