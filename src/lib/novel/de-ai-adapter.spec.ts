/**
 * de-ai-adapter.ts — 全口径覆盖 (无既有 spec)。
 *
 * 覆盖面: loadCustomDeAiSkill / buildQmQuaiSystemPrompt / buildDeAiSystemPrompt /
 * buildQmQuaiRewriteMessages / buildDeAiRewriteMessages / injectDeAiDirective /
 * loadSmartDeAiSkill (含内部 detectContentGenre / genreToSkillPath /
 * tryLoadSkillFromBundle)。
 *
 * 依赖 mock: @/commands/fs.readFile + @tauri-apps/api/path.join/resourceDir
 * (de-ai-adapter 只经 Tauri path API 拼路径, 无文件系统真实读写)。
 * SKILL.md 经 `?raw` 真实导入 (renderer/vitest 均可用)。
 */
import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
  resourceDir: vi.fn(async () => "/resources"),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
}))

vi.mock("@tauri-apps/api/path", () => ({
  join: mocks.join,
  resourceDir: mocks.resourceDir,
}))

import {
  loadCustomDeAiSkill,
  buildQmQuaiSystemPrompt,
  buildDeAiSystemPrompt,
  buildQmQuaiRewriteMessages,
  buildDeAiRewriteMessages,
  injectDeAiDirective,
  loadSmartDeAiSkill,
} from "./de-ai-adapter"

beforeEach(() => {
  mocks.readFile.mockReset()
  mocks.join.mockClear()
  mocks.resourceDir.mockClear()
})

describe("loadCustomDeAiSkill", () => {
  it("returns null when projectPath is missing", async () => {
    await expect(loadCustomDeAiSkill(undefined)).resolves.toBeNull()
    await expect(loadCustomDeAiSkill(null)).resolves.toBeNull()
    expect(mocks.join).not.toHaveBeenCalled()
  })

  it("returns trimmed content when the custom skill file exists", async () => {
    mocks.readFile.mockResolvedValue("  自定义去AI味规则  \n")
    await expect(loadCustomDeAiSkill("E:/Novel")).resolves.toBe("自定义去AI味规则")
    expect(mocks.join).toHaveBeenCalledWith("E:/Novel", "de-ai-skill.txt")
  })

  it("returns null when the file is empty/whitespace-only", async () => {
    mocks.readFile.mockResolvedValue("   \n ")
    await expect(loadCustomDeAiSkill("E:/Novel")).resolves.toBeNull()
  })

  it("returns null when reading throws", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await expect(loadCustomDeAiSkill("E:/Novel")).resolves.toBeNull()
  })
})

describe("buildQmQuaiSystemPrompt / buildDeAiSystemPrompt", () => {
  it("prefers trimmed custom skill over the built-in QM-QUAI prompt", () => {
    expect(buildQmQuaiSystemPrompt("  custom skill  ")).toBe("custom skill")
    expect(buildDeAiSystemPrompt("  custom skill  ")).toBe("custom skill")
  })

  it("falls back to the built-in SKILL.md prompt for empty/whitespace/undefined skill", () => {
    const fallback = buildQmQuaiSystemPrompt()
    const blank = buildQmQuaiSystemPrompt("   ")
    const blankDe = buildDeAiSystemPrompt("   ")
    expect(fallback.length).toBeGreaterThan(100)
    expect(fallback).toContain("de-AI-writing")
    expect(blank).toBe(fallback)
    expect(blankDe).toBe(fallback)
    expect(buildDeAiSystemPrompt()).toBe(fallback)
  })
})

describe("buildQmQuaiRewriteMessages / buildDeAiRewriteMessages", () => {
  it("throws on empty content (去AI味内容为空)", () => {
    expect(() => buildQmQuaiRewriteMessages("   ")).toThrow(/去AI味内容为空/)
    expect(() => buildDeAiRewriteMessages("")).toThrow(/去AI味内容为空/)
  })

  it("builds system+user messages with the resolved system prompt", () => {
    const messages = buildQmQuaiRewriteMessages("正文内容", "  custom skill  ")
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toBe("custom skill")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("正文内容")

    const de = buildDeAiRewriteMessages("正文内容")
    expect(de[0].content).toBe(buildQmQuaiSystemPrompt())
  })
})

describe("injectDeAiDirective", () => {
  it("returns content unchanged when disabled", () => {
    const content = "正文"
    expect(injectDeAiDirective(content, false)).toBe(content)
  })

  it("prefixes the directive block when enabled", () => {
    const out = injectDeAiDirective("正文", true)
    expect(out.startsWith("请保持剧情一致")).toBe(true)
    expect(out).toContain("任务内容：")
    expect(out).toContain("正文")
  })
})

describe("loadSmartDeAiSkill (场景自动选择)", () => {
  it("returns null when projectPath is missing", async () => {
    await expect(loadSmartDeAiSkill(null, "写正文")).resolves.toBeNull()
  })

  it("highest priority: custom de-ai-skill.txt wins over scene detection", async () => {
    mocks.readFile.mockResolvedValueOnce("  用户自定义skill  ")
    const skill = await loadSmartDeAiSkill("E:/Novel", "翻译这段话")
    expect(skill).toBe("用户自定义skill")
  })

  it("custom file empty → falls through to genre detection (translation → de-ai-writing)", async () => {
    mocks.readFile.mockResolvedValueOnce("   ")
    mocks.resourceDir.mockResolvedValue("/res")
    mocks.readFile.mockResolvedValueOnce("翻译专用 skill 内容")
    const skill = await loadSmartDeAiSkill("E:/Novel", "帮我翻译这段英文")
    expect(skill).toBe("翻译专用 skill 内容")
  })

  it("custom readFile throws → 科普/评论 genre → good-writing skill bundle", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("no custom"))
    mocks.readFile.mockResolvedValueOnce("good-writing 内容")
    const science = await loadSmartDeAiSkill("E:/Novel", "写一篇科普文章")
    expect(science).toBe("good-writing 内容")

    mocks.readFile.mockRejectedValueOnce(new Error("no custom"))
    mocks.readFile.mockResolvedValueOnce("good-writing 内容2")
    const commentary = await loadSmartDeAiSkill("E:/Novel", "写一篇书评")
    expect(commentary).toBe("good-writing 内容2")
  })

  it("outline genre: xuanhuan/wuxia 等标记 → web-novel → de-ai-writing bundle", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("no custom"))
    mocks.readFile.mockResolvedValueOnce("de-ai-writing bundle")
    const skill = await loadSmartDeAiSkill("E:/Novel", "生成第三章正文", {
      outline: "## 大纲\ngenre: xuanhuan\n第一章 测试",
    } as never)
    expect(skill).toBe("de-ai-writing bundle")
  })

  it("outline without a genre marker → defaults to web-novel bundle", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("no custom"))
    mocks.readFile.mockResolvedValueOnce("de-ai-writing bundle")
    const skill = await loadSmartDeAiSkill("E:/Novel", "生成第三章正文", {
      outline: "## 大纲\n第一章 测试（无 genre 标记）",
    } as never)
    expect(skill).toBe("de-ai-writing bundle")
  })

  it("outline genre not in the web-novel list → falls back to web-novel bundle", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("no custom"))
    mocks.readFile.mockResolvedValueOnce("de-ai-writing bundle")
    const skill = await loadSmartDeAiSkill("E:/Novel", "生成第三章正文", {
      outline: "## 大纲\ngenre: literary\n第一章 测试",
    } as never)
    expect(skill).toBe("de-ai-writing bundle")
  })

  it("bundle content whitespace-only → tryLoadSkillFromBundle 返回 null → 整体 null", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("no custom"))
    mocks.readFile.mockResolvedValueOnce("   ")
    await expect(loadSmartDeAiSkill("E:/Novel", "写一章正文")).resolves.toBeNull()
  })

  it("bundle load failure → returns null (调用方用内置规则兜底)", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("no custom"))
    mocks.readFile.mockRejectedValueOnce(new Error("bundle missing"))
    await expect(loadSmartDeAiSkill("E:/Novel", "写一章正文")).resolves.toBeNull()
  })
})
