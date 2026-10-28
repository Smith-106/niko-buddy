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

/**
 * 既不走原生 tools 字段、也不走文本解析的 provider。
 *
 * 四个 CLI transport 都不转发 `tools`（claude-cli / codex-cli /
 * antigravity-cli / cursor-cli-proxy 全文零处 `tools`），区别在兼容手段：
 *  - `cursor-cli` 靠 `providerUsesTextToolCalls` 注入 prompt 约定，让模型把工具调用
 *    写成 JSON 再由 runner 解析 —— **它确实支持工具**，所以不在本名单。
 *  - `claude-code` / `codex-cli` / `antigravity-cli` 既无 tools 字段也无文本解析，
 *    注册了也永远不会被执行（“静默零工具调用”）。
 *
 * 旧名单写的是 claude-code + cursor-cli，恰好把两者搞反：cursor-cli 被误禁而
 * codex-cli / antigravity-cli 被漏禁。
 */
const TOOL_UNSUPPORTED_PROVIDERS = new Set<LlmConfig["provider"]>([
  "claude-code",
  "codex-cli",
  "antigravity-cli",
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
 * 三条均返回 true。`anthropic_messages` 曾经硬返回 false，理由是「自定义端点
 * 的代理质量不可知，代理不透传 tools 会直接 400」。但这个理由两头都不成立：
 *   - 它把 `minimax-global` / `minimax-cn` 两个预设一并禁了。这两个预设是
 *     provider:"custom" + apiMode:"anthropic_messages"，而 provider:"minimax"
 *     分支没有任何预设可达——等于用户从下拉框选 MiniMax 永远拿不到工具。
 *   - 代理不透传 tools 时上游返回的 400 已被 runner 处理：
 *     isToolUnsupportedError 判定后 retryWithoutTools 重试一轮，并置
 *     attemptedToolsFallback。所以“注册了但用不上”能自动降级，不需要在
 *     注册层一刀切。
 *
 * 残留风险（如实记录）：若代理**静默丢弃** tools（200 但不返回 tool_use，
 * 不报错），就没有错误可触发 fallback。这种代理只能靠用户关掉函数调用开关
 * （isFunctionCallingEnabled）避开。
 */
export function apiModeSupportsTools(
  apiMode?: "chat_completions" | "responses" | "anthropic_messages",
): boolean {
  return (
    apiMode === undefined ||
    apiMode === "chat_completions" ||
    apiMode === "responses" ||
    apiMode === "anthropic_messages"
  )
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
  // 唯一判定入口：provider 能力 + apiMode 协议 + 模型前缀 + 用户开关。
  // 旧写法只看 apiMode，于是 claude-code / codex-cli / antigravity-cli 三个
  // provider 会注册 23 个工具却永远不会被 transport 转发（静默退化）。
  const toolsEnabled = effectiveToolsEnabled(modelId, options.llmConfig)
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
