// @vitest-environment node
/**
 * 章纲定位子弹解析：模板占位（`1-5`）不是数据。
 *
 * 这条 spec 存在的理由：v2.18.0 的 loader 用 `(\d{1,2})` 抓区间前缀，
 * 把未填写的章纲模板读成「压力级 1 / 情绪强度 1」，等于凭空造目标节奏。
 */
import { describe, expect, it, vi } from "vitest"
import { chapterDraftPath, loadStyleRadarInput, parseOutlinePositionBullets } from "./style-radar-loader"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(async () => "") }
})

vi.mock("./novel-session-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./novel-session-status")>()
  return { ...actual, loadNovelSessionStatus: vi.fn(async () => null) }
})

vi.mock("./context-engine-outline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-engine-outline")>()
  return { ...actual, readChapterOutlineContent: vi.fn(async () => "") }
})

import { readFile } from "@/commands/fs"
import { readChapterOutlineContent } from "./context-engine-outline"
import { loadNovelSessionStatus } from "./novel-session-status"

describe("parseOutlinePositionBullets", () => {
  it("模板占位区间不产生数值", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：1-5\n- 情绪强度：1-10")
    expect(parsed.pressureLevel).toBeNull()
    expect(parsed.emotionIntensity).toBeNull()
  })

  it("真实数值按标签取值", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：3\n- 情绪强度：7")
    expect(parsed.pressureLevel).toBe(3)
    expect(parsed.emotionIntensity).toBe(7)
  })

  it("超出量纲范围的数值不采纳", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：9\n- 情绪强度：11")
    expect(parsed.pressureLevel).toBeNull()
    expect(parsed.emotionIntensity).toBeNull()
  })

  it("带括号说明的数值仍然可读", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：4（对峙）")
    expect(parsed.pressureLevel).toBe(4)
  })

  it("缺标签即 N/A", () => {
    expect(parseOutlinePositionBullets("本章无定位子弹").pressureLevel).toBeNull()
  })
})

describe("chapterDraftPath（Draft-first 正式正文落点）", () => {
  it("按 .novel/chapters/{n}/draft.md 组装", () => {
    expect(chapterDraftPath("/p/book", 7)).toBe("/p/book/.novel/chapters/7/draft.md")
  })
})

describe("loadStyleRadarInput（风格雷达唯一读盘入口）", () => {
  const statusOf = (chapterNumber: unknown) => ({
    current_task: { chapter_number: chapterNumber },
  })

  it("空项目路径 → null（面板空态，不画空雷达）", async () => {
    await expect(loadStyleRadarInput("")).resolves.toBeNull()
    expect(loadNovelSessionStatus).not.toHaveBeenCalled()
  })

  it("无 status → null（项目未初始化）", async () => {
    vi.mocked(loadNovelSessionStatus).mockResolvedValueOnce(null)
    await expect(loadStyleRadarInput("/p/book")).resolves.toBeNull()
  })

  it("status 读取抛错 → null（不把失败画成数据）", async () => {
    vi.mocked(loadNovelSessionStatus).mockRejectedValueOnce(new Error("status gone"))
    await expect(loadStyleRadarInput("/p/book")).resolves.toBeNull()
  })

  it.each([0, -3, Number.NaN, "3", null, undefined])("非法章号 %p → null（不断言无章正文）", async (raw) => {
    vi.mocked(loadNovelSessionStatus).mockResolvedValueOnce(statusOf(raw) as never)
    await expect(loadStyleRadarInput("/p/book")).resolves.toBeNull()
  })

  it("正文+定位子弹齐全 → text 与目标节奏（章标签/压力/情绪）", async () => {
    vi.mocked(loadNovelSessionStatus).mockResolvedValueOnce(statusOf(3) as never)
    vi.mocked(readFile).mockResolvedValueOnce("第一章正文……")
    vi.mocked(readChapterOutlineContent).mockResolvedValueOnce("- 压力级：3\n- 情绪强度：7")
    const input = await loadStyleRadarInput("/p/book")
    expect(input?.text).toBe("第一章正文……")
    expect(input?.target).toEqual({ chapterLabel: "第 3 章", pressureLevel: 3, emotionIntensity: 7 })
    expect(readFile).toHaveBeenCalledWith("/p/book/.novel/chapters/3/draft.md")
  })

  it("正文读失败 → text 置空串但仍返回输入（缺正文走空态分支，不断链）", async () => {
    vi.mocked(loadNovelSessionStatus).mockResolvedValueOnce(statusOf(5) as never)
    vi.mocked(readFile).mockRejectedValueOnce(new Error("draft missing"))
    vi.mocked(readChapterOutlineContent).mockResolvedValueOnce("- 压力级：2")
    const input = await loadStyleRadarInput("/p/book")
    expect(input?.text).toBe("")
    expect(input?.target?.chapterLabel).toBe("第 5 章")
    expect(input?.target?.pressureLevel).toBe(2)
  })

  it("章纲读失败 → 定位按缺标签落 N/A（null），不默认 1", async () => {
    vi.mocked(loadNovelSessionStatus).mockResolvedValueOnce(statusOf(9) as never)
    vi.mocked(readFile).mockResolvedValueOnce("正文")
    vi.mocked(readChapterOutlineContent).mockRejectedValueOnce(new Error("outline gone"))
    const input = await loadStyleRadarInput("/p/book")
    expect(input?.target).toEqual({ chapterLabel: "第 9 章", pressureLevel: null, emotionIntensity: null })
  })
})
