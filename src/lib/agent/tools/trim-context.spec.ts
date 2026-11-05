/** C4 冒烟覆盖：src/lib/agent/tools/trim-context.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createTrimContextTool } from "./trim-context"
import type { ContextPack } from "@/lib/novel"

describe("trim-context.ts smoke", () => {
  it("exports createTrimContextTool", () => {
    expect(createTrimContextTool).toBeDefined()
  })
})

/**
 * trim_context 虚拟工具行为契约（P2-IMP-07 / ISS-20260709-033）。
 * 关注可观察行为：预算空分支、hardInject 渲染开关穿参、缺省回退惰性 store、
 * 渲染失败兜底文案。生产代码零改动。
 */
function packWith(over: Partial<ContextPack> = {}): ContextPack {
  return {
    task: "写第7章：雨夜追凶",
    chapterGoal: "林云在雨夜追到码头",
    outline: "第7章大纲",
    recentSummaries: ["第6章：林云发现纸条"],
    previousChapterEnding: "他把纸条塞进口袋。",
    characterStates: "林云：左臂受伤",
    soulDoc: "冷硬克制，短句。",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
    ...over,
  }
}

const HARD_INJECT_ITEM = "硬注入事实：林云的剑在第五章折断"

describe("trim_context 行为", () => {
  it("tokenBudget 为 0: 直接返回上下文为空提示（不渲染、不读 flag）", async () => {
    const tool = createTrimContextTool(packWith(), 0, { hardInjectEnabled: true })
    await expect(tool.execute({})).resolves.toBe("【上下文为空】tokenBudget 为 0，已跳过上下文加载")
  })

  it("tokenBudget > 0: 渲染提示串（含任务/章目标），并转发 hardInjectEnabled=true", async () => {
    const tool = createTrimContextTool(
      packWith({ hardInject: [{ text: HARD_INJECT_ITEM } as never] }),
      4000,
      { hardInjectEnabled: true },
    )

    const result = (await tool.execute({})) as string

    expect(result).toContain("写第7章：雨夜追凶")
    expect(result).toContain("林云在雨夜追到码头")
    // flag=true → 硬注入段渲染（穿参生效的可观察证据）
    expect(result).toContain(HARD_INJECT_ITEM)
  })

  it("hardInjectEnabled=false: 同一 pack 不渲染硬注入段（开关可逆）", async () => {
    const tool = createTrimContextTool(
      packWith({ hardInject: [{ text: HARD_INJECT_ITEM } as never] }),
      4000,
      { hardInjectEnabled: false },
    )

    const result = (await tool.execute({})) as string

    expect(result).toContain("写第7章：雨夜追凶")
    expect(result).not.toContain(HARD_INJECT_ITEM)
  })

  it("未注入 deps: 回退惰性读取 wiki store 的 novelConfig.hardInjectEnabled", async () => {
    const tool = createTrimContextTool(
      packWith({ hardInject: [{ text: HARD_INJECT_ITEM } as never] }),
      4000,
    )

    const result = (await tool.execute({})) as string
    const { useWikiStore } = await import("@/stores/wiki-store")
    const expected = useWikiStore.getState().novelConfig.hardInjectEnabled === true

    expect(result).toContain("写第7章：雨夜追凶")
    expect(result.includes(HARD_INJECT_ITEM)).toBe(expected)
  })

  it("渲染抛错: 返回错误文案（含原因），不向调用方抛异常", async () => {
    const exploding = packWith()
    Object.defineProperty(exploding, "task", {
      get() {
        throw new Error("pack corrupted")
      },
    })
    const tool = createTrimContextTool(exploding, 4000, { hardInjectEnabled: false })

    await expect(tool.execute({})).resolves.toBe("错误：裁剪上下文失败 - pack corrupted")
  })
})
