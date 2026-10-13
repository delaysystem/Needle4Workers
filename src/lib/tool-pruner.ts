export interface NormalizedTool {
  name: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
  [key: string]: any;
}

export interface PreparedToolsResult {
  minifiedJson: string;
  prunedCount: number;
  originalCount: number;
  selectedTools: NormalizedTool[];
  savedTokensEstimate: number;
}

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't",
  "down", "during", "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have",
  "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here", "here's", "hers", "herself", "him",
  "himself", "his", "how", "how's", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't",
  "it", "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my", "myself", "no", "nor",
  "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out",
  "over", "own", "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so",
  "some", "such", "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then",
  "there", "there's", "these", "they", "they'd", "they'll", "they're", "they've", "this", "those",
  "through", "to", "too", "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll",
  "we're", "we've", "were", "weren't", "what", "what's", "when", "when's", "where", "where's",
  "which", "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would", "wouldn't",
  "you", "you'd", "you'll", "you're", "you've", "your", "yours", "yourself", "yourselves", "please"
]);

/**
 * Split camelCase, snake_case, kebab-case, or space-separated text into normalized lowercase tokens.
 */
function extractTokens(str: string): string[] {
  if (!str || typeof str !== "string") {
    return [];
  }
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9_]/g, " ")
    .split(/[\s_]+/)
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s.length > 1 && !STOP_WORDS.has(s));
}

/**
 * Unwraps OpenAI {"type": "function", "function": {...}} into flat {name, description, parameters}.
 */
export function normalizeTool(tool: any): NormalizedTool {
  if (!tool || typeof tool !== "object") {
    return {
      name: "",
      description: "",
      parameters: { type: "object", properties: {} },
    };
  }

  if (tool.type === "function" && tool.function && typeof tool.function === "object") {
    const fn = tool.function;
    return {
      name: String(fn.name || ""),
      description: String(fn.description || ""),
      parameters:
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
    };
  }

  return {
    name: String(tool.name || ""),
    description: String(tool.description || ""),
    parameters:
      tool.parameters && typeof tool.parameters === "object"
        ? tool.parameters
        : { type: "object", properties: {} },
  };
}

/**
 * Scores candidate tools by token overlap across tool name, description, and required parameters,
 * and returns the top maxTools most relevant tools.
 */
export function pruneTools(tools: any[], query: string, maxTools: number = 5): NormalizedTool[] {
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }

  const normalizedTools: NormalizedTool[] = tools.map(normalizeTool);
  if (normalizedTools.length <= maxTools) {
    return normalizedTools;
  }

  const queryTokens = extractTokens(query);
  const lowerQuery = query.toLowerCase();

  const scored = normalizedTools.map((tool, index) => {
    let score = 0;
    const lowerName = tool.name.toLowerCase();

    // Exact matches between query and tool name
    if (lowerName && lowerQuery.includes(lowerName)) {
      score += 20;
    } else if (lowerName && lowerName.includes(lowerQuery.trim())) {
      score += 15;
    }

    const nameTokens = extractTokens(tool.name);
    const descTokens = extractTokens(tool.description);
    const properties = tool.parameters?.properties || {};
    const propKeys = Object.keys(properties);
    const propTokens = propKeys.flatMap(extractTokens);
    const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
    const requiredTokens = required.flatMap(extractTokens);

    for (const q of queryTokens) {
      if (nameTokens.includes(q)) {
        score += 8;
      }
      if (requiredTokens.includes(q)) {
        score += 5;
      }
      if (propTokens.includes(q)) {
        score += 3;
      }
      if (descTokens.includes(q)) {
        score += 2;
      }
      // Partial prefix/stem match on tool name
      if (nameTokens.some((t) => (t.startsWith(q) || q.startsWith(t)) && Math.min(t.length, q.length) >= 3)) {
        score += 1;
      }
    }

    return { tool, score, index };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });

  return scored.slice(0, maxTools).map((item) => item.tool);
}

/**
 * Deep copies the tool and strips non-essential schema noise:
 * $schema, title, default, examples, verbose property descriptions, additionalProperties.
 */
export function minifySchema(tool: any): NormalizedTool {
  const norm = normalizeTool(tool);
  const copy: NormalizedTool = JSON.parse(JSON.stringify(norm));

  function cleanSchemaNode(node: any): void {
    if (!node || typeof node !== "object") {
      return;
    }

    delete node.$schema;
    delete node.title;
    delete node.default;
    delete node.examples;
    delete node.example;
    delete node.additionalProperties;
    delete node.$id;
    delete node.$comment;
    delete node.definitions;
    delete node.$defs;

    if (Array.isArray(node.required) && node.required.length === 0) {
      delete node.required;
    }

    if (node.properties && typeof node.properties === "object") {
      for (const key of Object.keys(node.properties)) {
        const prop = node.properties[key];
        if (prop && typeof prop === "object") {
          delete prop.$schema;
          delete prop.title;
          delete prop.default;
          delete prop.examples;
          delete prop.example;
          delete prop.additionalProperties;

          // Strip verbose property descriptions (>30 characters) to optimize prefill tokens
          if (typeof prop.description === "string" && prop.description.length > 30) {
            delete prop.description;
          }

          cleanSchemaNode(prop);
        }
      }
    }

    if (node.items && typeof node.items === "object") {
      cleanSchemaNode(node.items);
    }
  }

  if (copy.parameters) {
    cleanSchemaNode(copy.parameters);
  }

  return copy;
}

/**
 * Normalizes, prunes, minifies, and serializes to compact JSON (no whitespace).
 * Returns { minifiedJson, prunedCount, originalCount, selectedTools, savedTokensEstimate }.
 */
export function prepareToolsForNeedle(
  tools: any[],
  query: string,
  maxTools: number = 5
): PreparedToolsResult {
  const originalCount = Array.isArray(tools) ? tools.length : 0;
  const originalJson = JSON.stringify(tools || []);

  const selected = pruneTools(tools, query, maxTools).map(minifySchema);
  const minifiedJson = JSON.stringify(selected);

  const prunedCount = originalCount - selected.length;
  const savedChars = Math.max(0, originalJson.length - minifiedJson.length);
  const savedTokensEstimate = Math.round(savedChars / 4);

  return {
    minifiedJson,
    prunedCount,
    originalCount,
    selectedTools: selected,
    savedTokensEstimate,
  };
}

export default {
  normalizeTool,
  pruneTools,
  minifySchema,
  prepareToolsForNeedle,
};
