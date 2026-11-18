/** OpenAI chat.completion envelope builder, shared by worker and router.
 * Pure: no engine imports, safe to bundle into the featherweight router.
 */

export interface ChatCall {
  name: string;
  arguments: Record<string, any>;
}

export function buildChatResponse(
  calls: ChatCall[],
  rawOutput: string,
  reasoning: string | null,
  model: string
): Record<string, any> {
  const toolCalls = calls.map((fc) => ({
    id: `call_${crypto.randomUUID().slice(0, 9)}`,
    type: "function",
    function: {
      name: fc.name,
      arguments: typeof fc.arguments === "string" ? fc.arguments : JSON.stringify(fc.arguments || {}),
    },
  }));
  const hasToolCalls = toolCalls.length > 0;
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: hasToolCalls ? null : rawOutput,
          ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      },
    ],
  };
}
