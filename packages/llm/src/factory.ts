import type { LlmProvider, LlmProviderKind } from "./types.js";
import type { LlmSettings } from "./settings.js";
import { ClaudeAgentProvider } from "./providers/claude-agent.js";
import { OpenAICompatProvider } from "./providers/openai-compat.js";
import { OllamaProvider } from "./providers/ollama.js";

export function createLlmProvider(
  settings: LlmSettings,
  kind: LlmProviderKind = settings.activeProvider,
): LlmProvider {
  switch (kind) {
    case "claude-code":
      return new ClaudeAgentProvider(settings.claudeCode);
    case "openai-compat":
      return new OpenAICompatProvider(settings.openaiCompat);
    case "ollama":
      return new OllamaProvider(settings.ollama);
  }
}
