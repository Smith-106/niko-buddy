import { describe, expect, it } from "vitest"
import {
  extractH1Headings,
  isBareChapterLabel,
  isRichChapterTitle,
  normalizeChapterDocument,
  readFrontmatterTitle,
  resolveChapterTitle,
} from "./chapter-typography"

const chapterWithBareTitle = [
  "---",
  "type: chapter",
  "chapter_number: '1'",
  "chapter_status: final",
  "title: 第1章",
  "source: autonomous-campaign",
  "created: '2026-10-05'",
  "---",
  "",
  "# 第1章",
  "",
  "# 第1章 身体赎回倒计时",
  "",
  "白曦在门口站了两秒，没急着进去。",
  "",
].join("\n")

describe("isBareChapterLabel / isRichChapterTitle", () => {
  it("裸标签：阿拉伯数字与中文数字的『第N章』识别为裸标签", () => {
    expect(isBareChapterLabel("第3章")).toBe(true)
    expect(isBareChapterLabel("第三章")).toBe(true)
    expect(isBareChapterLabel("第 12 节")).toBe(true)
    expect(isBareChapterLabel("第7卷")).toBe(true)
  })

  it("带章节名 / 文件名 / 空串不算裸标签", () => {
    expect(isBareChapterLabel("第3章 律师说没漏洞")).toBe(false)
    expect(isBareChapterLabel("chapter-001")).toBe(false)
    expect(isBareChapterLabel("")).toBe(false)
  })

  it("富标题要求章节名非空，且与裸标签互斥；支持无分隔符章名，排除回合同名实体", () => {
    expect(isRichChapterTitle("第5章 律师说没漏洞")).toBe(true)
    expect(isRichChapterTitle("第5章：律师说没漏洞")).toBe(true)
    expect(isRichChapterTitle("第一章测试")).toBe(true)
    expect(isRichChapterTitle("第10章初见")).toBe(true)
    expect(isRichChapterTitle("第十七回大闹天空")).toBe(true)
    expect(isRichChapterTitle("第5章")).toBe(false)
    expect(isRichChapterTitle("序章")).toBe(false)
    // RV-106 实体名：第三回合不是章节
    expect(isRichChapterTitle("第三回合")).toBe(false)
    expect(isBareChapterLabel("第一章测试")).toBe(false)
  })
})

describe("readFrontmatterTitle / extractH1Headings", () => {
  it("读取 frontmatter title 并跳过 frontmatter 提取全部 H1", () => {
    expect(readFrontmatterTitle(chapterWithBareTitle)).toBe("第1章")
    expect(extractH1Headings(chapterWithBareTitle)).toEqual(["第1章", "第1章 身体赎回倒计时"])
  })

  it("无 frontmatter 时 title 为 undefined，H1 照常提取", () => {
    expect(readFrontmatterTitle("# 第2章 醒")).toBeUndefined()
    expect(extractH1Headings("# 第2章 醒\n\n正文")).toEqual(["第2章 醒"])
  })
})

describe("resolveChapterTitle（只升级不降级）", () => {
  it("frontmatter 为裸标签 + 正文存在富 H1 → 取富 H1（TOC 显示章节名的核心用例）", () => {
    expect(resolveChapterTitle(chapterWithBareTitle)).toBe("第1章 身体赎回倒计时")
  })

  it("frontmatter 已是富标题 → 直接用它，不被正文 H1 覆盖", () => {
    const content = chapterWithBareTitle.replace("title: 第1章", "title: 第1章 契约成立")
    expect(resolveChapterTitle(content)).toBe("第1章 契约成立")
  })

  it("frontmatter 为裸标签且正文无富 H1 → 保留裸标签而非降级为空", () => {
    const content = ["---", "type: chapter", "title: 第3章", "---", "", "# 第3章", "", "正文"].join("\n")
    expect(resolveChapterTitle(content)).toBe("第3章")
  })

  it("无 frontmatter 的导入章节 → 取正文首个 H1", () => {
    expect(resolveChapterTitle("# 第9章 黑市柯叔\n\n正文")).toBe("第9章 黑市柯叔")
  })

  it("完全无标题信息 → 回退文件名派生标题", () => {
    expect(resolveChapterTitle("正文而已", "chapter 007")).toBe("chapter 007")
  })
})

describe("normalizeChapterDocument（写入边界归一，幂等）", () => {
  it("裸 frontmatter + 双 H1 → 同步富标题并收敛为单一 canonical H1", () => {
    const result = normalizeChapterDocument(chapterWithBareTitle, { normalizeBody: false })
    expect(result.title).toBe("第1章 身体赎回倒计时")
    expect(result.changed).toBe(true)
    expect(result.changes.titleSynced).toBe(true)
    expect(result.changes.headingsDeduped).toBe(1)
    expect(readFrontmatterTitle(result.content)).toBe("第1章 身体赎回倒计时")
    expect(extractH1Headings(result.content)).toEqual(["第1章 身体赎回倒计时"])
  })

  it("frontmatter 其他字段逐字节保留（chapter_number/status/source/created 不动）", () => {
    const result = normalizeChapterDocument(chapterWithBareTitle, { normalizeBody: false })
    expect(result.content).toContain("type: chapter")
    expect(result.content).toContain("chapter_number: '1'")
    expect(result.content).toContain("chapter_status: final")
    expect(result.content).toContain("source: autonomous-campaign")
    expect(result.content).toContain("created: '2026-10-05'")
    expect(result.content.startsWith("---\ntype: chapter")).toBe(true)
  })

  it("幂等：二次调用 changed=false，正文与标题不再变化", () => {
    const first = normalizeChapterDocument(chapterWithBareTitle)
    const second = normalizeChapterDocument(first.content)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)
    expect(second.changes).toEqual({ titleSynced: false, headingsDeduped: 0, bodyNormalized: false })
  })

  it("已规范文档（单 H1 + 富标题）→ changed=false", () => {
    const clean = [
      "---",
      "type: chapter",
      "chapter_number: '5'",
      'title: "第5章 律师说没漏洞"',
      "---",
      "",
      "# 第5章 律师说没漏洞",
      "",
      "法律援助站在东街尽头。",
      "",
    ].join("\n")
    const result = normalizeChapterDocument(clean)
    expect(result.changed).toBe(false)
  })

  it("正文排版规范化：省略号/引号等交由 normalizeMarkdownBody 统一", () => {
    const content = [
      "---",
      'title: "第2章 醒"',
      "---",
      "",
      "# 第2章 醒",
      "",
      '他说道：“走吧...”',
      "",
    ].join("\n")
    const result = normalizeChapterDocument(content)
    expect(result.changes.bodyNormalized).toBe(true)
    expect(result.content).toContain("「") // 半角/全角引号统一为「」
    expect(result.content).not.toContain("...")
  })

  it("preferredTitle 优先于文档解析结果（campaign 任务标题已知时用调用方的）", () => {
    const result = normalizeChapterDocument(chapterWithBareTitle, {
      preferredTitle: "第1章 合同首付",
      normalizeBody: false,
    })
    expect(result.title).toBe("第1章 合同首付")
    expect(readFrontmatterTitle(result.content)).toBe("第1章 合同首付")
    expect(extractH1Headings(result.content)).toEqual(["第1章 合同首付"])
  })

  it("无 frontmatter 时不凭空新增头块，只整理正文标题", () => {
    const result = normalizeChapterDocument("# 第4章\n\n# 第4章 二十四小时不可抗力\n\n正文", {
      normalizeBody: false,
    })
    expect(result.content.startsWith("---")).toBe(false)
    expect(extractH1Headings(result.content)).toEqual(["第4章 二十四小时不可抗力"])
  })
})
