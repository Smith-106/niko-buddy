import type { Tool } from "../types"
import { contextPackToPrompt } from "@/lib/novel/context-engine"
import type { ContextPack } from "@/lib/novel/context-engine"

/**
 * @param tokenBudget ContextPack token budget (not characters).
 */
export function createTrimContextTool(contextPack: ContextPack, tokenBudget: number): Tool {
  return {
    name: "trim_context",
    description:
      "虚拟工具：将 ContextPack 按 tokenBudget 预算裁剪为最终提示字符串。由管道前置链自动执行，LLM 不直接调用。",
    category: "virtual",
    parameters: {},
    execute: async () => {
      if (tokenBudget <= 0) {
        return "【上下文为空】tokenBudget 为 0，已跳过上下文加载"
      }
      try {
        return contextPackToPrompt(contextPack, tokenBudget)
      } catch (e) {
        return `错误：裁剪上下文失败 - ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}
