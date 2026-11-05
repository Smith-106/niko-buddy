import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FrontmatterParseResult, FrontmatterValue } from "@/lib/frontmatter"
import { parseOutlineMarkdownToModel } from "./outline-model-parse"

// R-补：frontmatter 对象分支（parse 内联 outline_model 为对象时）经真实
// parseFrontmatter 不可达——normalize(stringifyScalar) 把一切嵌套对象压成
// string（FrontmatterValue = string | string[]，类型级可证）。以下经依赖替换
// 构造对象输入，锁定 readModelObject 的真实行为（若上游 normalize 放宽对象
// 透传，此分支即激活；行为断言届时直接生效）。缺省透传真实实现，既有
// 24 个用例零影响。
const frontmatterObjectStub = vi.hoisted(() => ({
  model: null as unknown,
}))
vi.mock("@/lib/frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
  return {
    ...actual,
    parseFrontmatter: (content: string): FrontmatterParseResult => {
      if (frontmatterObjectStub.model !== null) {
        return {
          frontmatter: {
            outline_model: frontmatterObjectStub.model,
          } as unknown as Record<string, FrontmatterValue>,
          body: content,
          rawBlock: "",
        }
      }
      return actual.parseFrontmatter(content)
    },
  }
})

beforeEach(() => {
  frontmatterObjectStub.model = null
})

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

  // 覆盖增补：续行护栏里的「另一条 heading 紧跟空标题卷」形态。
  // 若把 `# 第2卷` 当卷名续行，第 2 卷会被揉进第 1 卷的标题（结构丢失）；
  // 必须归 false 后由 heading 分支重建新卷。
  it("紧跟的卷 heading 不是续行（新卷不被当卷名取走）", () => {
    const res = parseOutlineMarkdownToModel(head + "# 第2卷\n## 第1章 开篇\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes).toHaveLength(2)
    expect(res.model.volumes.map((v) => v.number)).toEqual([1, 2])
    expect(res.model.volumes[0]!.title).toBe("第1卷")
    expect(res.model.volumes[1]!.title).toBe("第2卷")
    // 章落在第 2 卷（当前卷已切换到新卷）。
    expect(res.model.volumes[1]!.chapters).toHaveLength(1)
  })

  it("紧跟的章 heading 不是续行（章不被当卷名取走）", () => {
    const res = parseOutlineMarkdownToModel(head + "## 第3章 开局\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes).toHaveLength(1)
    expect(res.model.volumes[0]!.title).toBe("第1卷")
    expect(res.model.volumes[0]!.chapters).toHaveLength(1)
    expect(res.model.volumes[0]!.chapters[0]!.chapter).toBe(3)
    expect(res.model.volumes[0]!.chapters[0]!.title).toBe("开局")
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

describe("outline-model-parse 覆盖增补：collectListItems 空行跳过", () => {
  it("小节内空行被跳过、两侧条目合并（collectListItems !trimmed 分支）", () => {
    const res = parseOutlineMarkdownToModel(
      ["# 第1卷", "## 第1章 开篇", "### 场景", "- 山洞", "", "- 河边", ""].join("\n"),
      { updatedAt: UPDATED_AT },
    )
    expect(res.model.volumes[0]!.chapters[0]!.prose.scenes).toEqual(["山洞", "河边"])
  })

  it("实体小节内空行同样被跳过", () => {
    const res = parseOutlineMarkdownToModel(
      ["# 第1卷", "## 第1章 开篇", "### 登场角色", "- 苏七", "", "  ", "- 林晚", ""].join("\n"),
      { updatedAt: UPDATED_AT },
    )
    expect(res.model.volumes[0]!.chapters[0]!.entities).toEqual(["苏七", "林晚"])
  })
})

describe("outline-model-parse 行为锁定：YAML 映射形态 outline_model 同样走 heading", () => {
  // 背景：normalize(stringifyScalar) 把 YAML 映射压成 JSON 字符串，
  // 故即便手写映射形态，运行时仍是 string，frontmatter 对象分支不可达。
  // 该用例把「映射形态不得干扰 heading 解析」钉死。
  it("YAML 映射 outline_model 被压平忽略，走 heading 流程", () => {
    const content = [
      "---",
      "outline_model:",
      "  volumes: []",
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
})

describe("outline-model-parse 覆盖增补：frontmatter 对象分支（依赖替换构造）", () => {
  it("满字段对象模型 → frontmatter 源 + high/1 + 信号与回填断言", () => {
    frontmatterObjectStub.model = {
      schemaVersion: 3,
      updatedAt: "2025-05-05",
      volumes: [
        {
          number: 1,
          title: "卷一",
          arc: "卷弧",
          chapters: [
            {
              chapter: 1,
              title: "开篇",
              arc: "章弧",
              pov: "苏七",
              entities: ["甲", 123, "  "],
              constraints: "禁夜行、禁泄密",
              foreshadow: { plant: "XX-1，YY-2", payoff: ["ZZ-3"] },
              prose: { goal: "立冲突", scenes: "山洞、河边", emotion: "燃" },
              updatedAt: "2025-01-01",
            },
          ],
        },
      ],
    }
    const res = parseOutlineMarkdownToModel("# 正文应被忽略\n", { updatedAt: UPDATED_AT })
    expect(res.source).toBe("frontmatter")
    expect(res.warnings).toEqual([])
    expect(res.confidence).toBe("high")
    expect(res.confidenceScore).toBe(1)
    expect(res.signals.volumeHeadings).toBe(1)
    expect(res.signals.chapterCount).toBe(1)
    expect(res.signals.filledSections).toBeGreaterThan(0)
    const ch = res.model.volumes[0]!.chapters[0]!
    expect(ch.title).toBe("开篇")
    expect(ch.arc).toBe("章弧")
    expect(ch.pov).toBe("苏七")
    expect(ch.entities).toEqual(["甲"])
    expect(ch.constraints).toEqual(["禁夜行", "禁泄密"])
    expect(ch.foreshadow).toEqual({ plant: ["XX-1", "YY-2"], payoff: ["ZZ-3"] })
    expect(ch.prose).toEqual({ goal: "立冲突", scenes: ["山洞", "河边"], emotion: "燃" })
    expect(ch.updatedAt).toBe("2025-01-01")
    expect(res.model.volumes[0]!.arc).toBe("卷弧")
    expect(res.model.updatedAt).toBe("2025-05-05")
  })

  it("空 volumes → 警告 + low/0.3", () => {
    frontmatterObjectStub.model = { volumes: [] }
    const res = parseOutlineMarkdownToModel("任意正文\n", { updatedAt: UPDATED_AT })
    expect(res.source).toBe("frontmatter")
    expect(res.warnings).toEqual(["frontmatter.outline_model 未包含任何卷"])
    expect(res.confidence).toBe("low")
    expect(res.confidenceScore).toBe(0.3)
    expect(res.model.volumes).toEqual([])
  })

  it("volumes 非数组 → 空卷警告；updatedAt 回退 options", () => {
    frontmatterObjectStub.model = { volumes: "不是数组", updatedAt: "" }
    const res = parseOutlineMarkdownToModel("任意正文\n", { updatedAt: UPDATED_AT })
    expect(res.source).toBe("frontmatter")
    expect(res.warnings).toEqual(["frontmatter.outline_model 未包含任何卷"])
    expect(res.confidence).toBe("low")
    expect(res.model.updatedAt).toBe(UPDATED_AT)
  })

  it("卷/章缺省回退：号缺省→1、标题缺省→第N卷/空、时间回退 options", () => {
    frontmatterObjectStub.model = {
      volumes: [
        {
          chapters: [{}, { chapter: "2", title: "  有号章  " }],
        },
      ],
    }
    const res = parseOutlineMarkdownToModel("任意正文\n", { updatedAt: UPDATED_AT })
    expect(res.source).toBe("frontmatter")
    const vol = res.model.volumes[0]!
    expect(vol.number).toBe(1)
    expect(vol.title).toBe("第1卷")
    expect(vol.arc).toBe("")
    expect(vol.chapters).toHaveLength(2)
    expect(vol.chapters[0]!.chapter).toBe(1)
    expect(vol.chapters[0]!.title).toBe("")
    expect(vol.chapters[0]!.updatedAt).toBe(UPDATED_AT)
    expect(vol.chapters[0]!.foreshadow).toEqual({ plant: [], payoff: [] })
    expect(vol.chapters[0]!.prose).toEqual({ goal: "", scenes: [], emotion: "" })
    expect(vol.chapters[1]!.chapter).toBe(2)
    expect(vol.chapters[1]!.title).toBe("有号章")
    // 两章零填充 → filledSections=0 → 非 confident → low（0.3 固定分）
    expect(res.confidence).toBe("low")
    expect(res.confidenceScore).toBe(0.3)
  })

  it("多卷按号排序（sort 比较器执行）", () => {
    frontmatterObjectStub.model = {
      volumes: [{ number: 2, chapters: [] }, { number: 1, chapters: [] }],
    }
    const res = parseOutlineMarkdownToModel("任意正文\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes.map((v) => v.number)).toEqual([1, 2])
    expect(res.warnings).toEqual([])
  })
})

describe("outline-model-parse 分支覆盖补齐（R-26：分支 miss 清零）", () => {
  it("伏笔小节：无 ID 行走 ?? []、有 ID 无埋收关键词行走 target null", () => {
    const res = parseOutlineMarkdownToModel(
      ["# 第1卷", "## 第1章 开篇", "### 伏笔", "本章埋了个钩子", "伏笔 AB-12 已经出现", ""].join(
        "\n",
      ),
      { updatedAt: UPDATED_AT },
    )
    const ch = res.model.volumes[0]!.chapters[0]!
    // 第一行无编号 → match 回 null 走 ?? []，target 落 plant 但无 ID 可记；
    // 第二行有 ID 但既无埋/plant 也无收/payoff → target null，不污染双向。
    expect(ch.foreshadow).toEqual({ plant: [], payoff: [] })
  })

  it("英文章标题 heading（Chapter N）走 [1] ?? [2] 右侧", () => {
    const res = parseOutlineMarkdownToModel("# Chapter 5: Title\n", { updatedAt: UPDATED_AT })
    const ch = res.model.volumes[0]!.chapters[0]!
    expect(ch.chapter).toBe(5)
    expect(ch.title).toBe("Title")
  })

  it("裸文本英文章标题（Chapter N）走 [1] ?? [2] 右侧", () => {
    const res = parseOutlineMarkdownToModel("Chapter 5 Title\n## 第1章 开篇\n", {
      updatedAt: UPDATED_AT,
    })
    expect(res.model.volumes[0]!.chapters.map((c) => c.chapter)).toEqual([5, 1])
  })

  it("裸文本卷形态「卷3」走 [1] ?? [2] 右侧", () => {
    const res = parseOutlineMarkdownToModel("卷3 冒险\n## 第1章 开篇\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.number).toBe(3)
    expect(res.model.volumes[0]!.title).toBe("冒险")
  })

  it("裸文本卷形态「Volume 3」走 [2] ?? [3] 右侧", () => {
    const res = parseOutlineMarkdownToModel("Volume 3 Adventure\n## 第1章 开篇\n", {
      updatedAt: UPDATED_AT,
    })
    expect(res.model.volumes[0]!.number).toBe(3)
    expect(res.model.volumes[0]!.title).toBe("Adventure")
  })

  it("卷标题续行 strip 后为空 → 回退原文（|| trimmed 右侧）", () => {
    const res = parseOutlineMarkdownToModel("# 第1卷\n** **\n", { updatedAt: UPDATED_AT })
    expect(res.model.volumes[0]!.title).toBe("** **")
  })

  it("frontmatter volumes 含 null 项 → 空对象卷（?? {} + 非数组 chapters）", () => {
    frontmatterObjectStub.model = { volumes: [null] }
    const res = parseOutlineMarkdownToModel("任意正文\n", { updatedAt: UPDATED_AT })
    expect(res.source).toBe("frontmatter")
    expect(res.model.volumes).toHaveLength(1)
    expect(res.model.volumes[0]!.number).toBe(1)
    expect(res.model.volumes[0]!.title).toBe("第1卷")
    expect(res.model.volumes[0]!.chapters).toEqual([])
    expect(res.warnings).toEqual([])
  })

  it("frontmatter chapters 含 null 项 → 空对象章（?? {}）", () => {
    frontmatterObjectStub.model = { volumes: [{ number: 2, chapters: [null] }] }
    const res = parseOutlineMarkdownToModel("任意正文\n", { updatedAt: UPDATED_AT })
    expect(res.source).toBe("frontmatter")
    const ch = res.model.volumes[0]!.chapters[0]!
    expect(ch.chapter).toBe(1)
    expect(ch.title).toBe("")
    expect(ch.updatedAt).toBe(UPDATED_AT)
    expect(ch.foreshadow).toEqual({ plant: [], payoff: [] })
  })
})
