import { describe, expect, it } from "vitest"
import { parseOutlineMarkdownToModel } from "./outline-model-parse"

const UPDATED_AT = "2026-01-01"

describe("outline-model-parse 行为锁定：frontmatter outline_model 非对象值被忽略", () => {
  // 背景：parseFrontmatter().normalize 把一切嵌套对象 JSON.stringify 化（frontmatter.ts
  // stringifyScalar），故 fm.outline_model 运行时恒为 string|string[]，走 heading 流程。
  // 以下用例把该守卫行为钉死：字符串/数组 outline_model 不得干扰 heading 解析。
  it("字符串 outline_model 被忽略，走 heading 流程", () => {
    const content = [
      "---",
      'outline_model: "{\\"volumes\\": []}"',
      "---",
      "# 第1卷",
      "## 第1章 开篇",
      "### 本章目标",
      "做X",
      "",
    ].join("\n")
    const res = parseOutlineMarkdownToModel(content, { updatedAt: UPDATED_AT })
    expect(res.source).toBe("heading")
    expect(res.model.volumes).toHaveLength(1)
    expect(res.model.volumes[0]!.chapters[0]!.prose.goal).toBe("做X")
  })

  it("数组 outline_model 被忽略（Array.isArray 排除），走 heading 流程", () => {
    const content = ["---", "outline_model: [1, 2]", "---", "# 第1卷", "## 第1章 开篇", ""].join("\n")
    const res = parseOutlineMarkdownToModel(content, { updatedAt: UPDATED_AT })
    expect(res.source).toBe("heading")
    expect(res.model.volumes).toHaveLength(1)
  })
})

describe("outline-model-parse 覆盖增补：readNumber/readStringArray 原子分支", () => {
  it("数字卷号 + 字符串实体：readNumber 数字分支 / readStringArray 字符串分支", () => {
    const content = [
      "---",
      "volume: 1",
      "chapter: 2",
      "title: 结构章",
      "entities: 苏七、林晚",
      "---",
      "## 第2章 新标题",
      "### 本章目标",
      "做X",
      "",
    ].join("\n")
    const res = parseOutlineMarkdownToModel(content, { updatedAt: UPDATED_AT })
    expect(res.source).toBe("heading")
    const ch = res.model.volumes[0]!.chapters[0]!
    // 结构化挂载：标题以后来者为准？此处 fm 带 title → 保持 fm 标题
    expect(ch.title).toBe("结构章")
    expect(ch.entities).toEqual(["苏七", "林晚"])
    expect(ch.prose.goal).toBe("做X")
  })

  it("结构化复用且 fm 无标题：正文标题回填已挂载章（R-09，不增 heading）", () => {
    const content = ["---", "volume: 1", "chapter: 1", "---", "## 第1章 新标题", "### 本章目标", "做X", ""].join("\n")
    const res = parseOutlineMarkdownToModel(content, { updatedAt: UPDATED_AT })
    const ch = res.model.volumes[0]!.chapters[0]!
    expect(ch.title).toBe("新标题")
    expect(res.signals.chapterHeadings).toBe(0)
  })

  it("空白字符串卷号：numberFromLabel 空串回 null → 走 heading 流程", () => {
    const content = ["---", 'volume: " "', "chapter: 1", "---", "# 第1卷", "## 第1章 开篇", "### 本章目标", "做X", ""].join(
      "\n",
    )
    const res = parseOutlineMarkdownToModel(content, { updatedAt: UPDATED_AT })
    expect(res.model.volumes).toHaveLength(1)
    expect(res.model.volumes[0]!.chapters).toHaveLength(1)
    expect(res.model.volumes[0]!.chapters[0]!.prose.goal).toBe("做X")
  })
})

describe("outline-model-parse 覆盖增补：标签排版噪声归一化", () => {
  it("【】包裹的小节标签命中目标字段", () => {
    const res = parseOutlineMarkdownToModel(
      "# 第1卷\n## 第1章 开篇\n### 【本章目标】\n建立冲突\n",
      { updatedAt: UPDATED_AT },
    )
    expect(res.model.volumes[0]!.chapters[0]!.prose.goal).toBe("建立冲突")
  })

  it("粗体小节标签命中目标字段", () => {
    const res = parseOutlineMarkdownToModel(
      "# 第1卷\n## 第1章 开篇\n### **本章目标**\n建立冲突\n",
      { updatedAt: UPDATED_AT },
    )
    expect(res.model.volumes[0]!.chapters[0]!.prose.goal).toBe("建立冲突")
  })

  it("同字段别名第二段为空：appendText 空串回退（保留已有）", () => {
    const res = parseOutlineMarkdownToModel(
      "# 第1卷\n## 第1章 开篇\n### 视角\n苏七\n### POV\n",
      { updatedAt: UPDATED_AT },
    )
    expect(res.model.volumes[0]!.chapters[0]!.pov).toBe("苏七")
  })
})

describe("outline-model-parse 覆盖增补：卷标题续行护栏", () => {
  const head = "# 第1卷\n"

  it("超长行（>30）不是续行", () => {
    const res = parseOutlineMarkdownToModel(head + "这是续行探针0123456789abcdefghij0123456789\n", {
      updatedAt: UPDATED_AT,
    })
    expect(res.model.volumes[0]!.title).toBe("第1卷")
  })

  it("句号结尾不是续行", () => {
    const res = parseOutlineMarkdownToModel(head + "短续行。\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("第1卷")
  })

  it("小节 heading 不是续行（落进小节解析）", () => {
    const res = parseOutlineMarkdownToModel(head + "## 小节标题\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("第1卷")
  })

  it("列表条目不是续行", () => {
    const res = parseOutlineMarkdownToModel(head + "- 条目续行\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("第1卷")
  })

  it("行内标签不是续行", () => {
    const res = parseOutlineMarkdownToModel(head + "**本章目标**：内容详情\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("第1卷")
  })

  it("裸卷文本命中卷标题形态不是续行（升级为新卷）", () => {
    const res = parseOutlineMarkdownToModel(head + "第2卷 卷二\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes).toHaveLength(2)
    expect(res.model.volumes[0]!.title).toBe("第1卷")
    expect(res.model.volumes[1]!.title).toBe("卷二")
  })

  it("小节标签文本不是续行", () => {
    const res = parseOutlineMarkdownToModel(head + "本章目标\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("第1卷")
  })

  it("含冒号的散文不是续行", () => {
    const res = parseOutlineMarkdownToModel(head + "作者：苏七\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("第1卷")
  })

  it("合格短行接管卷标题", () => {
    const res = parseOutlineMarkdownToModel(head + "卷首语\n## 第1章 开篇\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("卷首语")
  })
})

describe("outline-model-parse 覆盖增补：编号夹取与置信度极端", () => {
  it("重复卷号复用同一卷（ensureVolume 已存在分支）", () => {
    const res = parseOutlineMarkdownToModel("# 第1卷\n# 第1卷\n## 第1章 开篇\n", {
      updatedAt: UPDATED_AT,
    })
    expect(res.model.volumes).toHaveLength(1)
    expect(res.model.volumes[0]!.chapters).toHaveLength(1)
  })

  it("裸卷文本标题建卷（非 # 形态走 stripped 分支）", () => {
    const res = parseOutlineMarkdownToModel("第1卷 卷一\n第2卷 卷二\n## 第1章 开篇\n正文\n", {
      updatedAt: UPDATED_AT,
    })
    expect(res.model.volumes.map((v) => v.title)).toEqual(["卷一", "卷二"])
  })

  it("超大 Volume 数字溢出 Infinity → clampNumber null 回退（无警告）", () => {
    const res = parseOutlineMarkdownToModel(`# Volume ${"9".repeat(400)}\n## 第1章 开篇\n`, {
      updatedAt: UPDATED_AT,
    })
    expect(res.model.volumes[0]!.number).toBe(1)
    expect(res.warnings.filter((w) => w.includes("卷号非法"))).toEqual([])
  })

  it("警告过多拉低原始分到负数：clamp01 负数分支 + low 档", () => {
    const res = parseOutlineMarkdownToModel(`${"# 楔子\n".repeat(26)}`, { updatedAt: UPDATED_AT })
    expect(res.warnings.length).toBeGreaterThanOrEqual(23)
    expect(res.confidence).toBe("low")
    expect(res.model.volumes[0]!.chapters.length).toBe(26)
  })
})
