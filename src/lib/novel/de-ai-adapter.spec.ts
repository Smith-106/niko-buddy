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

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: mocks.readFile,
    
  }
})

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
  extractSkillVersion,
  BUILTIN_DE_AI_SKILL_VERSION,
  DEFAULT_DE_AI_MODE,
  runDeAiDetection,
  buildDeAiEditMessages,
  parseDeAiEditPlan,
  applyDeAiSpanEdits,
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

  it("Wave 4: 不传 extra 时输出与旧版字节一致（additive-only）", () => {
    const baseline = buildQmQuaiRewriteMessages("正文内容", "custom")
    const withEmptyExtra = buildQmQuaiRewriteMessages("正文内容", "custom", {})
    const withBlankExtra = buildQmQuaiRewriteMessages("正文内容", "custom", {
      userPrompt: "   ",
      dualPassFragment: "  ",
    })
    expect(withEmptyExtra).toEqual(baseline)
    expect(withBlankExtra).toEqual(baseline)
  })

  it("Wave 4: userPrompt 追加到 system、dualPassFragment 追加到 user 内容", () => {
    const messages = buildQmQuaiRewriteMessages("正文内容", "custom", {
      userPrompt: "个性化规则",
      dualPassFragment: "## De-AI dual-pass\n- 机械腔 warn",
    })
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toContain("custom")
    expect(messages[0].content).toContain("个性化规则")
    expect(messages[1].content).toContain("## De-AI dual-pass")
    expect(messages[1].content).toContain("正文内容")
    // 消息条数不变（仅内容追加，不增减消息）
    expect(messages).toHaveLength(2)
  })

  it("Wave 4: buildDeAiRewriteMessages 透传 extra", () => {
    const messages = buildDeAiRewriteMessages("正文内容", undefined, { userPrompt: "规则" })
    expect(messages[0].content).toContain("规则")
  })

  it("P0-1: cavityGuard 注入改写器腔 must-not-emit 到 system", () => {
    const no = buildQmQuaiRewriteMessages("正文内容", "custom")
    expect(no[0].content).not.toContain("改写器腔禁止")
    const yes = buildQmQuaiRewriteMessages("正文内容", "custom", { cavityGuard: true })
    expect(yes[0].content).toContain("改写器腔禁止")
    expect(yes[0].content).toContain("假口语")
    // 用户 prompt 存在时 guard 也注入
    const both = buildQmQuaiRewriteMessages("正文内容", "custom", {
      cavityGuard: true,
      userPrompt: "个性化",
    })
    expect(both[0].content).toContain("改写器腔禁止")
    expect(both[0].content).toContain("个性化")
  })
})

describe("extractSkillVersion / BUILTIN_DE_AI_SKILL_VERSION (P2-1 skill-versioning)", () => {
  it("解析 SKILL.md frontmatter version", () => {
    const md = `---\nname: x\nmetadata:\n  version: "1.2.3"\n---\n# body`
    expect(extractSkillVersion(md)).toBe("1.2.3")
  })

  it("无 version 字段返回 null", () => {
    expect(extractSkillVersion("---\nname: x\n---")).toBeNull()
    expect(extractSkillVersion("no frontmatter")).toBeNull()
  })

  it("内置 skill 版本与产品版本一致 (2.7.4)", () => {
    expect(BUILTIN_DE_AI_SKILL_VERSION).toBe("2.7.4")
  })

  // ---- 35 号 frontmatter 边界化（理论边角修复）----
  it("正文孤立 version: 行不再误配（核心修复点）", () => {
    const md = `---\nname: x\nversion: "1.0.0"\n---\n\nversion: 9.9.9 是最初的方案，后来废弃`
    expect(extractSkillVersion(md)).toBe("1.0.0")
  })

  it("无 frontmatter 但正文含 version: 行 → null", () => {
    const md = `# 标题\n\nversion: 9.9.9\n正文内容`
    expect(extractSkillVersion(md)).toBeNull()
  })

  it("正文代码块含 version: 行不影响 frontmatter 值", () => {
    const md = `---\nname: x\nversion: "2.0.0"\n---\n\n\`\`\`yaml\nversion: 8.8.8\n\`\`\``
    expect(extractSkillVersion(md)).toBe("2.0.0")
  })

  it("contentVersion/schemaVersion 不误配", () => {
    const md = `---\nname: x\nmetadata:\n  contentVersion: 1\n  schemaVersion: 2\n  version: "3.1.0"\n---`
    expect(extractSkillVersion(md)).toBe("3.1.0")
  })

  it("仅 frontmatter 含 contentVersion 无 version → null", () => {
    const md = `---\ncontentVersion: 1\n---\n正文 version: 8.8.8`
    expect(extractSkillVersion(md)).toBeNull()
  })

  it("CRLF 换行 frontmatter 解析成功", () => {
    const md = `---\r\nname: x\r\nversion: \"4.2.0\"\r\n---\r\n正文`
    expect(extractSkillVersion(md)).toBe("4.2.0")
  })

  it("BOM 前缀 frontmatter 解析成功", () => {
    const md = `\uFEFF---\nname: x\nversion: "5.0.0"\n---`
    expect(extractSkillVersion(md)).toBe("5.0.0")
  })

  it("frontmatter 未闭合 → null（严格边界）", () => {
    const md = `---\nname: x\nversion: "6.6.6"\n正文继续`
    expect(extractSkillVersion(md)).toBeNull()
  })

  it("顶层 version 与嵌套 metadata.version 并存 → 顶层优先", () => {
    const md = `---\nversion: "7.1.0"\nmetadata:\n  version: "7.0.0"\n---`
    expect(extractSkillVersion(md)).toBe("7.1.0")
  })

  it("version 无引号 + 行内注释截断", () => {
    const md = `---\nname: x\nversion: 7.7.7 # comment\n---`
    expect(extractSkillVersion(md)).toBe("7.7.7")
  })

  it("正文 markdown 分隔线（---）不干扰首块 frontmatter", () => {
    const md = `---\nversion: "8.0.0"\n---\n\n正文\n\n---\n尾部横线\nversion: 0.0.1`
    expect(extractSkillVersion(md)).toBe("8.0.0")
  })

  it("空串/纯空白 → null", () => {
    expect(extractSkillVersion("")).toBeNull()
    expect(extractSkillVersion("   \n  ")).toBeNull()
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

describe("DEFAULT_DE_AI_MODE & runDeAiDetection (detect 模式: 零 LLM 纯静态检测)", () => {
  it("DEFAULT_DE_AI_MODE 默认为 rewrite（保障既有兼容）", () => {
    expect(DEFAULT_DE_AI_MODE).toBe("rewrite")
  })

  it("空文本/纯空白早退返回空结果", () => {
    const empty = runDeAiDetection("")
    expect(empty.hits).toHaveLength(0)
    expect(empty.slopPenalty).toBe(0)
    expect(empty.slopClass).toBe("clean")
    expect(empty.markedText).toBe("")

    const blank = runDeAiDetection("   \n\t  ")
    expect(blank.hits).toHaveLength(0)
    expect(blank.slopPenalty).toBe(0)
    expect(blank.slopClass).toBe("clean")
  })

  it("干净文本无命中且为 clean 档", () => {
    const cleanText = "阿青挑着水桶走过石阶，水面晃出两只麻雀的倒影。院门虚掩着，风吹起一地干枯的槐树叶。"
    const result = runDeAiDetection(cleanText)
    expect(result.hits).toHaveLength(0)
    expect(result.slopClass).toBe("clean")
    expect(result.markedText).toBe(cleanText)
  })

  it("准确定位分级表与机械词（startIndex/endIndex/suggestion/markedText）", () => {
    const content = "显而易见，换句话说，他推开门走了出去。"
    const result = runDeAiDetection(content)
    expect(result.hits.length).toBeGreaterThanOrEqual(2)

    const hit1 = result.hits.find((h) => h.term === "显而易见")
    expect(hit1).toBeDefined()
    expect(hit1?.startIndex).toBe(0)
    expect(hit1?.endIndex).toBe(4)
    expect(hit1?.tier).toBe("1A")
    expect(hit1?.suggestion).toContain("删掉")

    const hit2 = result.hits.find((h) => h.term === "换句话说")
    expect(hit2).toBeDefined()
    expect(hit2?.startIndex).toBe(5)
    expect(hit2?.endIndex).toBe(9)
    expect(hit2?.tier).toBe("1A")

    expect(result.markedText).toContain("【显而易见】")
    expect(result.markedText).toContain("【换句话说】")
    expect(result.markedText).toContain("，他推开门走了出去。")
  })

  it("同一词多次出现时分别准确定位每个区间", () => {
    const content = "显然他在笑，显然他并不在意。"
    const result = runDeAiDetection(content)
    const hits = result.hits.filter((h) => h.term === "显然")
    expect(hits).toHaveLength(2)
    expect(hits[0].startIndex).toBe(0)
    expect(hits[0].endIndex).toBe(2)
    expect(hits[1].startIndex).toBe(6)
    expect(hits[1].endIndex).toBe(8)
  })

  it("纯同步运行，绝不调用任何异步/模型接口", () => {
    const fn = () => runDeAiDetection("显而易见，这毫无疑问。")
    // 返回值非 Promise
    const res = fn()
    expect(res).not.toBeInstanceOf(Promise)
    expect(res.hits.length).toBeGreaterThan(0)
  })
})

describe("buildDeAiEditMessages (edit 模式 Prompt 建造器)", () => {
  it("内容为空时抛错", () => {
    expect(() => buildDeAiEditMessages("")).toThrow(/去AI味内容为空/)
    expect(() => buildDeAiEditMessages("   \n  ")).toThrow(/去AI味内容为空/)
  })

  it("生成符合 review-rewrite-plan JSON 格式指示的消息契约", () => {
    const messages = buildDeAiEditMessages("正文片段", "自定义skill")
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toContain("原位定点修改（edit）")
    expect(messages[0].content).toContain("只返回 JSON 数组")
    expect(messages[0].content).toContain("original_text")
    expect(messages[0].content).toContain("replacement_text")
    expect(messages[0].content).toContain("自定义skill")

    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("正文如下：")
    expect(messages[1].content).toContain("正文片段")
  })
})

describe("parseDeAiEditPlan & applyDeAiSpanEdits (原位片段编辑与唯一锚点校验)", () => {
  it("解析标准 JSON 数组及 Markdown 代码块包装", () => {
    const rawJson = `\`\`\`json
[
  {
    "original_text": "显而易见的事实",
    "replacement_text": "真相",
    "note": "去掉AI腔"
  }
]
\`\`\``
    const edits = parseDeAiEditPlan(rawJson)
    expect(edits).toHaveLength(1)
    expect(edits[0].originalText).toBe("显而易见的事实")
    expect(edits[0].replacementText).toBe("真相")
    expect(edits[0].note).toBe("去掉AI腔")
  })

  it("成功应用唯一锚点修改，未修改区域保持字节级一致且保留 frontmatter 与标题", () => {
    const md = `---
title: 第1章
tags: [test]
---
# 第一章 出发

院子里的树叶落了一地。显而易见的事实摆在眼前，他不得不承认。

天色渐晚。`

    const edits = [
      {
        id: "edit-1",
        originalText: "显而易见的事实摆在眼前",
        replacementText: "真相就在眼前",
      },
    ]

    const result = applyDeAiSpanEdits(md, edits)
    expect(result.ok).toBe(true)
    expect(result.applied).toHaveLength(1)
    expect(result.markdown).toContain("---")
    expect(result.markdown).toContain("# 第一章 出发")
    expect(result.markdown).toContain("真相就在眼前，他不得不承认。")
    expect(result.markdown).toContain("院子里的树叶落了一地。")
    expect(result.markdown).toContain("天色渐晚。")

    // 未编辑部分一致性校验
    const prefix = "院子里的树叶落了一地。"
    const suffix = "，他不得不承认。\n\n天色渐晚。"
    expect(result.markdown).toContain(prefix)
    expect(result.markdown).toContain(suffix)
  })

  it("原串在正文中不存在（missing）时校验失败并记录 failed", () => {
    const md = `# 第1章\n\n正文内容在这里。`
    const edits = [
      {
        id: "edit-missing",
        originalText: "正文中根本不存在的一句话",
        replacementText: "替换文字",
      },
    ]
    const result = applyDeAiSpanEdits(md, edits)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].id).toBe("edit-missing")
    }
  })

  it("原串在正文中出现多次（duplicate / 非唯一）时校验失败并拒绝修改", () => {
    const md = `# 第1章\n\n显然，他走了。过了一会儿，显然他又回来了。`
    const edits = [
      {
        id: "edit-dup",
        originalText: "显然",
        replacementText: "其实",
      },
    ]
    const result = applyDeAiSpanEdits(md, edits)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].id).toBe("edit-dup")
    }
  })

  it("原串为空白时拒绝修改", () => {
    const md = `# 第1章\n\n正常文字。`
    const edits = [
      {
        id: "edit-empty",
        originalText: "   ",
        replacementText: "新文字",
      },
    ]
    const result = applyDeAiSpanEdits(md, edits)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failed).toHaveLength(1)
    }
  })

  it("多项修改中有一处锚点失败时，整体 ok=false 且标明失败项", () => {
    const md = `# 第1章\n\n阿青站起身来。桌上的茶杯已经凉了。`
    const edits = [
      {
        id: "edit-pass",
        originalText: "阿青站起身来",
        replacementText: "阿青推开门",
      },
      {
        id: "edit-fail",
        originalText: "不存在的碗筷",
        replacementText: "新碗筷",
      },
    ]
    const result = applyDeAiSpanEdits(md, edits)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].id).toBe("edit-fail")
      expect(result.applied).toHaveLength(1)
      expect(result.applied[0].edit.id).toBe("edit-pass")
    }
  })
})
