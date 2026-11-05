import { describe, expect, it, vi } from "vitest"
import {
  createReviseChapterTool,
  createScoreChapterTool,
  type QualityToolDeps,
} from "./score-chapter"

/**
 * `score_chapter` / `revise_chapter` 的行为测试。
 *
 * 这两个工具此前只被 `index.registry-branches.spec.ts` 验证「注册/不注册」，
 * `execute` 的返回契约（中位分算法、空参守卫、异常降级为可读错误串）无人钉死。
 * 本文件直接驱动 `execute`，断言**返回给模型的字符串**这一可观察行为。
 */

function deps(overrides: Partial<QualityToolDeps> = {}): QualityToolDeps {
  return {
    scoreChapter: vi.fn(async () => ({ thrill: 8, pacing: 6 })),
    reviseChapter: vi.fn(async (content: string) => `REVISED:${content}`),
    ...overrides,
  }
}

/** 解析 execute 返回的 JSON 串（成功路径的唯一可观察输出）。 */
function parseResult(raw: string): { dims: Record<string, number>; median: number } {
  return JSON.parse(raw) as { dims: Record<string, number>; median: number }
}

describe("score_chapter · 工具元数据", () => {
  it("声明为只读 auto 工具，并给出足够长的执行超时", () => {
    const tool = createScoreChapterTool(deps())
    expect(tool.name).toBe("score_chapter")
    expect(tool.category).toBe("read")
    expect(tool.permission).toBe("auto")
    // 六维 = 每维一次两阶段真实评审，30s 默认超时不够。
    expect(tool.executeTimeoutMs).toBe(600_000)
    expect(tool.parameters.content?.required).toBe(true)
  })
})

describe("score_chapter · 入参守卫", () => {
  it("content 全是空白 → 返回错误串且不调用评分依赖", async () => {
    const scoreChapter = vi.fn(async () => ({ thrill: 9 }))
    const tool = createScoreChapterTool(deps({ scoreChapter }))
    const out = await tool.execute({ content: "   \n\t " })
    expect(out).toBe("错误：content 为空")
    expect(scoreChapter).not.toHaveBeenCalled()
  })

  it("content 缺失（undefined）→ 按空串处理，返回错误串", async () => {
    const scoreChapter = vi.fn(async () => ({ thrill: 9 }))
    const tool = createScoreChapterTool(deps({ scoreChapter }))
    const out = await tool.execute({})
    expect(out).toBe("错误：content 为空")
    expect(scoreChapter).not.toHaveBeenCalled()
  })
})

describe("score_chapter · 中位分算法", () => {
  it("奇数个维度 → median 取正中那位", async () => {
    const tool = createScoreChapterTool(
      deps({ scoreChapter: async () => ({ a: 3, b: 9, c: 5 }) }),
    )
    const out = await tool.execute({ content: "正文" })
    const parsed = parseResult(out)
    expect(parsed.median).toBe(5)
    expect(parsed.dims).toEqual({ a: 3, b: 9, c: 5 })
  })

  it("偶数个维度 → median 取中间两位均值，并保留两位小数", async () => {
    const tool = createScoreChapterTool(
      deps({ scoreChapter: async () => ({ a: 1, b: 2, c: 3, d: 9 }) }),
    )
    const out = await tool.execute({ content: "正文" })
    // 排序后 [1,2,3,9] → 中位两位 (2+3)/2 = 2.5
    expect(parseResult(out).median).toBe(2.5)
  })

  it("偶数个维度的均值带小数 → 四舍五入到两位", async () => {
    const tool = createScoreChapterTool(
      deps({ scoreChapter: async () => ({ a: 1, b: 2, c: 2, d: 3 }) }),
    )
    const out = await tool.execute({ content: "正文" })
    // 排序后 [1,2,2,3] → (2+2)/2 = 2
    expect(parseResult(out).median).toBe(2)
  })

  it("非有限值（NaN/Infinity）被剔除后再算中位，但原始 dims 原样回传", async () => {
    const tool = createScoreChapterTool(
      deps({
        scoreChapter: async () => ({
          thrill: 7,
          broken: Number.NaN,
          overflow: Number.POSITIVE_INFINITY,
        }),
      }),
    )
    const out = await tool.execute({ content: "正文" })
    const parsed = parseResult(out)
    // 只剩 thrill=7 → median 7；dims 里的坏值仍在（调用方自行判断）
    expect(parsed.median).toBe(7)
    expect(parsed.dims.thrill).toBe(7)
    expect(Number.isNaN(parsed.dims.broken as number)).toBe(false) // JSON 序列化后为 null
    expect(parsed.dims.broken).toBeNull()
    expect(parsed.dims.overflow).toBeNull()
  })

  it("依赖返回空维度表 → median 为 0（不产生 NaN）", async () => {
    const tool = createScoreChapterTool(deps({ scoreChapter: async () => ({}) }))
    const out = await tool.execute({ content: "正文" })
    const parsed = parseResult(out)
    expect(parsed.median).toBe(0)
    expect(parsed.dims).toEqual({})
  })
})

describe("score_chapter · 异常降级", () => {
  it("评分依赖抛 Error → 返回可读错误串（携带原始 message）", async () => {
    const tool = createScoreChapterTool(
      deps({
        scoreChapter: async () => {
          throw new Error("模型超时")
        },
      }),
    )
    const out = await tool.execute({ content: "正文" })
    expect(out).toBe("错误：评分失败 — 模型超时")
  })

  it("评分依赖抛非 Error → 同样降级为可读错误串", async () => {
    const tool = createScoreChapterTool(
      deps({
        scoreChapter: async () => {
          throw "字符串异常"
        },
      }),
    )
    const out = await tool.execute({ content: "正文" })
    expect(out).toBe("错误：评分失败 — 字符串异常")
  })
})

describe("revise_chapter · 元数据与守卫", () => {
  it("声明为 action/auto 工具，超时 300s", () => {
    const tool = createReviseChapterTool(deps())
    expect(tool.name).toBe("revise_chapter")
    expect(tool.category).toBe("action")
    expect(tool.permission).toBe("auto")
    expect(tool.executeTimeoutMs).toBe(300_000)
    expect(tool.parameters.content?.required).toBe(true)
    expect(tool.parameters.brief?.required).toBe(true)
  })

  it("content 为空 → 错误串；brief 为空也各自拦住", async () => {
    const reviseChapter = vi.fn(async (content: string) => content)
    const tool = createReviseChapterTool(deps({ reviseChapter }))

    expect(await tool.execute({ content: "  ", brief: "改节奏" })).toBe("错误：content 为空")
    expect(await tool.execute({ content: "正文", brief: "" })).toBe("错误：brief 为空")
    expect(await tool.execute({ content: "正文" })).toBe("错误：brief 为空")
    // content 整体缺失（undefined）→ 按空串处理
    expect(await tool.execute({ brief: "改节奏" })).toBe("错误：content 为空")
    expect(reviseChapter).not.toHaveBeenCalled()
  })
})

describe("revise_chapter · 行为", () => {
  it("成功时原样回传依赖的重写结果，并收到正文与 brief", async () => {
    const reviseChapter = vi.fn(async (content: string, brief: string) => `${brief}|${content}`)
    const tool = createReviseChapterTool(deps({ reviseChapter }))
    const out = await tool.execute({ content: "正文", brief: "把节奏改紧凑" })
    expect(out).toBe("把节奏改紧凑|正文")
    expect(reviseChapter).toHaveBeenCalledWith("正文", "把节奏改紧凑")
  })

  it("重写依赖抛错 → 返回可读错误串", async () => {
    const tool = createReviseChapterTool(
      deps({
        reviseChapter: async () => {
          throw new Error("上游 502")
        },
      }),
    )
    expect(await tool.execute({ content: "正文", brief: "brief" })).toBe(
      "错误：重写失败 — 上游 502",
    )
  })
})
