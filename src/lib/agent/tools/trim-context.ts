import type { Tool } from "../types"
import { contextPackToPrompt } from "@/lib/novel"
import type { ContextPack } from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"

/**
 * @param tokenBudget ContextPack token budget (not characters).
 * @param deps ISS-20260709-033: 显式注入 UI 侧 flag，缺省回退惰性读 store
 * （向后兼容，行为等价；测试可注入确定值避免耦合 UI store）。
 */
export function createTrimContextTool(contextPack: ContextPack, tokenBudget: number, deps?: { hardInjectEnabled?: boolean }): Tool {
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
        // ISS-20260709-033: 注入优先（deps.hardInjectEnabled），缺省沿用原惰性
        // store 读取（向后兼容，行为等价）。
        const hardInjectEnabled = deps?.hardInjectEnabled
          ?? (await import("@/stores/wiki-store")).useWikiStore.getState().novelConfig.hardInjectEnabled
        return contextPackToPrompt(contextPack, tokenBudget, { hardInjectEnabled })
      } catch (e) {
        return `错误：裁剪上下文失败 - ${toErrorMessage(e)}`
      }
    },
  }
}
