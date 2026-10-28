import type { LlmConfig } from "@/stores/wiki-store"
import type { ToolRegistry } from "./registry"
import type { AgentConfig } from "./types"
import { DEFAULT_MAX_ROUNDS } from "./types"
import { registerAllBuiltInTools } from "./tools"
import type { ToolFactoryOptions } from "./tools"

const TOOL_UNSUPPORTED_MODEL_PREFIXES: string[] = [
  "o1",
  "o3-mini",
  "deepseek-reasoner",
  "claude-code",
  "cursor-cli",
]

const TOOL_UNSUPPORTED_PROVIDERS = new Set<LlmConfig["provider"]>([
  "claude-code",
  "cursor-cli",
])

/** cursor-api-proxy 无法返回原生 tool_calls delta，需从文本中解析工具调用。 */
export function providerUsesTextToolCalls(provider: LlmConfig["provider"]): boolean {
  return provider === "cursor-cli"
}

interface BuildAgentConfigOptions extends ToolFactoryOptions {
  llmConfig: LlmConfig
  requestOverrides?: AgentConfig["requestOverrides"]
}

/**
 * 该 wire 协议是否具备工具通道。
 *
 * 三条协议在 provider 层都已实现 tools 转发与流式工具调用解析：
 *   - `chat_completions` / `responses`：OpenAI 形状
 *   - `anthropic_messages`：tool_use / tool_result 块（parseAnthropicToolDelta）
 *
 * 但对 `custom` + `anthropic_messages` 仍返回 false。原因不是协议不支持，
 * 而是自定义端点的代理实现质量不可知：若代理不透传 tools，上游会直接 400，
 * 这比「不注册工具」对用户更糟。内置 anthropic / minimax 不经过这里
 * （它们不设 apiMode，恒为 undefined），走自己的已验证通道。
 */
export function apiModeSupportsTools(
  apiMode?: "chat_completions" | "responses" | "anthropic_messages",
): boolean {
  return apiMode !== "anthropic_messages"
}

export function modelSupportsTools(
  modelId: string,
  provider?: LlmConfig["provider"],
  apiMode?: "chat_completions" | "responses" | "anthropic_messages",
): boolean {
  if (provider && TOOL_UNSUPPORTED_PROVIDERS.has(provider)) return false
  if (!apiModeSupportsTools(apiMode)) return false

  const id = modelId.trim().toLowerCase()
  if (!id) return false

  const modelPart = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id

  return !TOOL_UNSUPPORTED_MODEL_PREFIXES.some((prefix) => {
    const lowerPrefix = prefix.toLowerCase()
    return id.startsWith(lowerPrefix) || modelPart.startsWith(lowerPrefix)
  })
}

/** Provider/user switch: undefined/true keeps tools; false strips tools/tool_choice. */
export function isFunctionCallingEnabled(llmConfig: LlmConfig): boolean {
  return (llmConfig as { functionCallingEnabled?: boolean }).functionCallingEnabled !== false
}

export function effectiveToolsEnabled(
  modelId: string,
  llmConfig: LlmConfig,
): boolean {
  return (
    modelSupportsTools(modelId, llmConfig.provider, llmConfig.apiMode) &&
    isFunctionCallingEnabled(llmConfig)
  )
}

export function buildAgentConfig(
  modelId: string,
  systemPrompt: string,
  registry: ToolRegistry,
  options: BuildAgentConfigOptions,
): AgentConfig {
  registry.clear()
  const fcEnabled = isFunctionCallingEnabled(options.llmConfig)
  // 协议不具备工具通道时（anthropic_messages）不注册工具：否则 Agent 会带着
  // 一份永远不会被执行的工具清单空转，表现为「静默零工具调用」。
  const toolsEnabled = fcEnabled && apiModeSupportsTools(options.llmConfig.apiMode)
  registerAllBuiltInTools(registry, toolsEnabled
    ? options
    : {
        ...options,
        enabledToolNames: [],
        mcpTools: [],
      })

  const prompt = providerUsesTextToolCalls(options.llmConfig.provider) && toolsEnabled
    ? `${systemPrompt}\n\n当需要调用工具时，请只输出一个 JSON 对象，格式为 {"name":"工具名","arguments":{...}}，不要附加其他说明文字。收到工具结果后继续推理；若无需工具则直接回答。`
    : systemPrompt

  return {
    maxRounds: DEFAULT_MAX_ROUNDS,
    tools: registry.list(),
    systemPrompt: prompt,
    llmConfig: options.llmConfig,
    modelId,
    projectPath: options.projectPath,
    requestOverrides: options.requestOverrides,
  }
}
