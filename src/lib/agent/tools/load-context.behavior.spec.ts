/**
 * load-context.ts 行为覆盖：虚拟工具把 ContextPack 摊平成提示词片段。
 *
 * 契约：
 *   - 有灵魂文档时前置「【作品灵魂】」段并带上数据源计数；
 *   - 无灵魂文档时只给数据源计数；
 *   - buildContextPack 抛错时返回中文错误串（调用方据此继续降级，不得 reject）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const buildContextPackMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/novel", () => ({
  buildContextPack: (...args: unknown[]) => buildContextPackMock(...args),
}))

import { createLoadContextTool } from "./load-context"

const PROJECT = "E:/Novel"

beforeEach(() => {
  buildContextPackMock.mockReset()
})

describe("createLoadContextTool", () => {
  it("声明为 virtual 分类的虚拟工具（LLM 不直接调用）", () => {
    const tool = createLoadContextTool(PROJECT, "写第三章", { chapterNumber: 3 } as never)

    expect(tool.name).toBe("load_context")
    expect(tool.category).toBe("virtual")
    expect(tool.parameters).toEqual({})
  })

  it("有灵魂文档时输出灵魂段 + 数据源计数，并把章节号传给上下文包", async () => {
    buildContextPackMock.mockResolvedValueOnce({
      soulDoc: "主角是剑修",
      outline: {},
      recentChapters: {},
    })
    const tool = createLoadContextTool(PROJECT, "写第三章", { chapterNumber: 3 } as never)

    const result = await tool.execute({ anything: true })

    expect(buildContextPackMock).toHaveBeenCalledWith(PROJECT, "写第三章", 3)
    expect(result).toBe("【作品灵魂】\n主角是剑修\n\n【上下文数据源】\n共加载 3 个数据源")
  })

  it("没有灵魂文档时只输出数据源计数", async () => {
    buildContextPackMock.mockResolvedValueOnce({ outline: {}, memories: {} })
    const tool = createLoadContextTool(PROJECT, "总结第二章", { chapterNumber: 2 } as never)

    const result = await tool.execute({})

    expect(result).toBe("【上下文数据源】\n共加载 2 个数据源")
    expect(result).not.toContain("作品灵魂")
  })

  it("路由结果缺章节号时传 undefined（上下文包按无章节号路径加载）", async () => {
    buildContextPackMock.mockResolvedValueOnce({ outline: {} })
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
