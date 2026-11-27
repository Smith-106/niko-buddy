/**
 * load-context.ts 行为覆盖：虚拟工具把完整 ContextPack 按预算渲染为提示词片段 + 非空数据源摘要。
 *
 * 契约：
 *   - 通过 contextPackToPrompt(pack, tokenBudget, { sectionCharBudget }) 渲染完整预算内上下文（不再丢弃 20/21 字段）；
 *   - 默认预算 tokenBudget=6000、sectionCharBudget=1600，支持 options 覆写；
 *   - 末尾附带简洁非空数据源摘要（忽略空串/空数组/元数据字段）；
 *   - buildContextPack 抛错时返回中文错误串（调用方据此继续降级，不得 reject）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const buildContextPackMock = vi.hoisted(() => vi.fn())
const contextPackToPromptMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/novel", () => ({
  buildContextPack: (...args: unknown[]) => buildContextPackMock(...args),
  contextPackToPrompt: (...args: unknown[]) => contextPackToPromptMock(...args),
}))

import { createLoadContextTool } from "./load-context"

const PROJECT = "E:/Novel"

beforeEach(() => {
  buildContextPackMock.mockReset()
  contextPackToPromptMock.mockReset()
})

describe("createLoadContextTool", () => {
  it("声明为 virtual 分类的虚拟工具（LLM 不直接调用）", () => {
    const tool = createLoadContextTool(PROJECT, "写第三章", { chapterNumber: 3 } as never)

    expect(tool.name).toBe("load_context")
    expect(tool.category).toBe("virtual")
    expect(tool.parameters).toEqual({})
  })

  it("经 contextPackToPrompt 渲染全部非空字段并附非空数据源摘要（默认预算 6000 / 1600）", async () => {
    const pack = {
      task: "写第三章",
      soulDoc: "主角是剑修",
      outline: "第3章：寒潭决战",
      characterStates: "苏砚：右臂负伤",
      foreshadowingStates: "旧玉佩尚未揭晓来历",
      canonRules: "不可凭空恢复灵力",
      recentSummaries: ["第1章：初入宗门", "第2章：秘境遇险"],
      timeline: "",
      styleExemplars: [],
      gaps: [{ type: "empty", ref: "timeline", reason: "no_data" }],
    }
    buildContextPackMock.mockResolvedValueOnce(pack)
    contextPackToPromptMock.mockReturnValueOnce(
      "## 作品灵魂\n主角是剑修\n\n## 大纲\n第3章：寒潭决战\n\n## 角色状态\n苏砚：右臂负伤\n\n## 伏笔\n旧玉佩尚未揭晓来历",
    )
    const tool = createLoadContextTool(PROJECT, "写第三章", { chapterNumber: 3 } as never)

    const result = await tool.execute({ anything: true })

    expect(buildContextPackMock).toHaveBeenCalledWith(PROJECT, "写第三章", 3)
    expect(contextPackToPromptMock).toHaveBeenCalledWith(pack, 6000, { sectionCharBudget: 1600 })
    expect(result).toContain("主角是剑修")
    expect(result).toContain("第3章：寒潭决战")
    expect(result).toContain("苏砚：右臂负伤")
    expect(result).toContain("旧玉佩尚未揭晓来历")
    expect(result).toContain("【上下文数据源摘要】已加载 6 个非空数据源")
    expect(result).toContain("outline")
    expect(result).toContain("characterStates")
    expect(result).toContain("foreshadowingStates")
    expect(result).not.toContain("timeline")
    expect(result).not.toContain("gaps")
  })

  it("透传自定义 tokenBudget 与 sectionCharBudget 选项", async () => {
    const pack = { task: "续写", outline: "第5章大纲" }
    buildContextPackMock.mockResolvedValueOnce(pack)
    contextPackToPromptMock.mockReturnValueOnce("## 大纲\n第5章大纲")
    const tool = createLoadContextTool(PROJECT, "续写第五章", { chapterNumber: 5 } as never, {
      tokenBudget: 4200,
      sectionCharBudget: 900,
    })

    const result = await tool.execute({})

    expect(contextPackToPromptMock).toHaveBeenCalledWith(pack, 4200, { sectionCharBudget: 900 })
    expect(result).toContain("## 大纲\n第5章大纲")
    expect(result).toContain("已加载 1 个非空数据源：outline")
  })

  it("非空字段全空且渲染结果为空时优雅返回空源摘要", async () => {
    buildContextPackMock.mockResolvedValueOnce({ task: "空任务", outline: "", recentSummaries: [] })
    contextPackToPromptMock.mockReturnValueOnce("")
    const tool = createLoadContextTool(PROJECT, "空任务", { chapterNumber: 2 } as never)

    const result = await tool.execute({})

    expect(result).toBe("【上下文数据源摘要】当前项目暂无可用非空上下文数据源")
  })

  it("路由结果缺章节号时传 undefined（上下文包按无章节号路径加载）", async () => {
    buildContextPackMock.mockResolvedValueOnce({ outline: "总纲" })
    contextPackToPromptMock.mockReturnValueOnce("## 大纲\n总纲")
    const tool = createLoadContextTool(PROJECT, "看看设定", {} as never)

    await tool.execute({})

    expect(buildContextPackMock).toHaveBeenCalledWith(PROJECT, "看看设定", undefined)
  })

  it("上下文包加载失败时返回中文错误串而不是 reject", async () => {
    buildContextPackMock.mockRejectedValueOnce(new Error("snapshot store corrupted"))
    const tool = createLoadContextTool(PROJECT, "写第三章", { chapterNumber: 3 } as never)

    await expect(tool.execute({})).resolves.toBe("错误：加载上下文失败 - snapshot store corrupted")
  })
})
