import type { Tool } from "../types"
import { contextPackToPrompt } from "@/lib/novel"
import type { ContextPack } from "@/lib/novel"

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
        // P2-IMP-07: hardInject 渲染门穿参（flag 默认 false → 缺省即关，零行为变化）。
        // 与 run-chapter-workflow.ts 同款惰性 store 读取，避免 lib 层静态耦合 UI store。
        const { useWikiStore } = await import("@/stores/wiki-store")
        const hardInjectEnabled = useWikiStore.getState().novelConfig.hardInjectEnabled
        return contextPackToPrompt(contextPack, tokenBudget, { hardInjectEnabled })
      } catch (e) {
        return `错误：裁剪上下文失败 - ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}
