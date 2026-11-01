import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  OUTLINE_MODEL_SCHEMA_VERSION,
  computeOutlineModelDigest,
  findOutlineChapter,
  flattenOutlineChapters,
  normalizeOutlineModel,
  outlineChapterId,
  outlineModelContentKey,
  parseOutlineChapterId,
  validateOutlineModel,
  type OutlineModel,
} from "./outline-model"
import { parseOutlineMarkdownToModel } from "./outline-model-parse"
import {
  renderOutlineChapterToMarkdown,
  renderOutlineModelToMarkdown,
} from "./outline-model-render"

function buildModel(): OutlineModel {
  return {
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    updatedAt: "2026-11-01",
    volumes: [
      {
        number: 1,
        title: "启程",
        arc: "少年出山，第一次见血",
        chapters: [
          {
            id: outlineChapterId(1, 1),
            volume: 1,
            chapter: 1,
            title: "断桥",
            pov: "李慕白",
            arc: "相遇",
            entities: ["李慕白", "苏七"],
            foreshadow: { plant: ["FS-001"], payoff: [] },
            constraints: ["苏七本章不出场"],
            prose: {
              goal: "让两人第一次照面并结下梁子",
              scenes: ["雨中破桥对峙", "剑鞘互击后各自离去"],
              emotion: "压抑→骤然紧张",
            },
            updatedAt: "2026-11-01",
          },
          {
            id: outlineChapterId(1, 2),
            volume: 1,
            chapter: 2,
            title: "旧账",
            pov: "",
            arc: "",
            entities: ["苏七"],
            foreshadow: { plant: [], payoff: ["FS-001"] },
            constraints: [],
            prose: { goal: "", scenes: [], emotion: "" },
            updatedAt: "2026-11-01",
          },
        ],
      },
      {
        number: 2,
        title: "入城",
        arc: "",
        chapters: [
          {
            id: outlineChapterId(2, 3),
            volume: 2,
            chapter: 3,
            title: "城门",
            pov: "",
            arc: "试探",
            entities: [],
            foreshadow: { plant: ["FS-002"], payoff: [] },
            constraints: ["不得出现现代词汇"],
            prose: { goal: "进城", scenes: ["验关"], emotion: "克制的敌意" },
            updatedAt: "2026-11-01",
          },
        ],
      },
    ],
  }
}

describe("outline-model id 编解码", () => {
  it("派生与反解互逆", () => {
    expect(outlineChapterId(2, 12)).toBe("v02c012")
    expect(parseOutlineChapterId("v02c012")).toEqual({ volume: 2, chapter: 12 })
    expect(parseOutlineChapterId("2-12")).toBeNull()
  })

  it("按卷章查章与拍平", () => {
    const model = buildModel()
    expect(findOutlineChapter(model, 1, 2)?.title).toBe("旧账")
    expect(findOutlineChapter(model, 9, 1)).toBeNull()
    expect(flattenOutlineChapters(model).map((chapter) => chapter.id)).toEqual([
      "v01c001",
      "v01c002",
      "v02c003",
    ])
  })
})

describe("outline-model 校验", () => {
  it("合法模型无 issue", () => {
    expect(validateOutlineModel(buildModel())).toEqual({ ok: true, issues: [] })
  })

  it("拦住重复章号、id 不一致、空标题、非法 schemaVersion", () => {
    const model = buildModel()
    model.schemaVersion = 99
    model.volumes[0].chapters[1].chapter = 1
    model.volumes[0].chapters[1].id = "v01c001"
    model.volumes[0].chapters[0].title = "  "

    const result = validateOutlineModel(model)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.includes("schemaVersion"))).toBe(true)
    expect(result.issues.some((issue) => issue.includes("章号重复"))).toBe(true)
    expect(result.issues.some((issue) => issue.includes("章标题为空"))).toBe(true)
  })

  it("pov 为空串合法：不新增校验 issue", () => {
    const model = buildModel()
    for (const volume of model.volumes) {
      for (const chapter of volume.chapters) chapter.pov = ""
    }
    expect(validateOutlineModel(model)).toEqual({ ok: true, issues: [] })
  })
})

describe("outline-model 渲染与回读往返", () => {
  it("整本渲染后可无损回读八类字段", () => {
    const model = buildModel()
    const markdown = renderOutlineModelToMarkdown(model, { digest: "abc123" })
    const parsed = parseOutlineMarkdownToModel(markdown)

    expect(parsed.confidence).toBe("high")
    expect(parsed.warnings).toEqual([])
    expect(outlineModelContentKey(parsed.model)).toBe(outlineModelContentKey(model))
    expect(parsed.model.volumes[0].arc).toBe("少年出山，第一次见血")
    expect(parsed.model.volumes[1].chapters[0].constraints).toEqual(["不得出现现代词汇"])
    expect(parsed.model.volumes[0].chapters[0].pov).toBe("李慕白")
  })

  it("渲染幂等：render(parse(render(m))) === render(m)", () => {
    const model = buildModel()
    const first = renderOutlineModelToMarkdown(model, { digest: "abc123" })
    const second = renderOutlineModelToMarkdown(parseOutlineMarkdownToModel(first).model, {
      digest: "abc123",
    })
    expect(second).toBe(first)
  })

  it("单章渲染可回读为同一章", () => {
    const model = buildModel()
    const markdown = renderOutlineChapterToMarkdown(model, "v01c001")
    const parsed = parseOutlineMarkdownToModel(markdown)
    const chapter = flattenOutlineChapters(parsed.model)[0]

    expect(chapter.id).toBe("v01c001")
    expect(chapter.title).toBe("断桥")
    expect(chapter.pov).toBe("李慕白")
    expect(chapter.arc).toBe("相遇")
    expect(chapter.entities).toEqual(["李慕白", "苏七"])
    expect(chapter.foreshadow).toEqual({ plant: ["FS-001"], payoff: [] })
    expect(chapter.constraints).toEqual(["苏七本章不出场"])
    expect(chapter.prose.scenes).toEqual(["雨中破桥对峙", "剑鞘互击后各自离去"])
  })

  it("找不到章节时抛错", () => {
    expect(() => renderOutlineChapterToMarkdown(buildModel(), "v09c999")).toThrow(/v09c999/)
  })

  it("pov 参与渲染与回读（空 pov 不渲染视角小节）", () => {
    const markdown = renderOutlineModelToMarkdown(buildModel())
    // 三章里只有 v01c001 有 pov → 恰好一个小节。
    expect(markdown.match(/### 视角/g)).toHaveLength(1)

    const parsed = parseOutlineMarkdownToModel(markdown)
    expect(flattenOutlineChapters(parsed.model).map((chapter) => chapter.pov)).toEqual([
      "李慕白",
      "",
      "",
    ])
  })

  it("单章渲染：空 pov 不写 pov frontmatter 行", () => {
    const withPov = renderOutlineChapterToMarkdown(buildModel(), "v01c001")
    expect(withPov).toContain('pov: "李慕白"')

    const withoutPov = renderOutlineChapterToMarkdown(buildModel(), "v01c002")
    expect(withoutPov).not.toContain("pov:")
    expect(withoutPov).not.toContain("### 视角")
  })
})

describe("outline-model 旧文本回退解析", () => {
  it("识别卷+章两层与七类小节（中文数字章号）", () => {
    const legacy = [
      "# 第一卷 启程",
      "## 第一章 断桥",
      "### 本章目标",
      "两人第一次照面",
      "### 场景",
      "- 雨中破桥对峙",
      "### 登场",
      "- 李慕白",
      "- 苏七",
      "### 伏笔",
      "- 埋设：FS-001",
      "### 约束",
      "- 苏七本章不出场",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    expect(parsed.confidence).toBe("high")
    const chapter = flattenOutlineChapters(parsed.model)[0]
    expect(parsed.model.volumes[0].title).toBe("启程")
    expect(chapter.chapter).toBe(1)
    expect(chapter.title).toBe("断桥")
    expect(chapter.prose.goal).toBe("两人第一次照面")
    expect(chapter.prose.scenes).toEqual(["雨中破桥对峙"])
    expect(chapter.entities).toEqual(["李慕白", "苏七"])
    expect(chapter.foreshadow.plant).toEqual(["FS-001"])
    expect(chapter.constraints).toEqual(["苏七本章不出场"])
  })

  it("缺卷标题时归入第 1 卷并记 warning", () => {
    const parsed = parseOutlineMarkdownToModel("## 第3章 独自上路\n\n### 本章目标\n赶路")
    // D2 契约变更：缺卷标题 → 中等档（不再是无区分度的 low）。
    expect(parsed.confidence).toBe("medium")
    expect(parsed.confidenceScore).toBeGreaterThanOrEqual(0.5)
    expect(parsed.confidenceScore).toBeLessThan(0.8)
    expect(parsed.warnings.some((warning) => warning.includes("未识别到卷标题"))).toBe(true)
    expect(parsed.model.volumes[0].number).toBe(1)
    expect(flattenOutlineChapters(parsed.model)[0].chapter).toBe(3)
  })

  it("完全没有章标题时给出空模型与 warning", () => {
    const parsed = parseOutlineMarkdownToModel("只是一段散文，没有任何标题。")
    expect(parsed.model.volumes).toEqual([])
    expect(parsed.warnings.some((warning) => warning.includes("未识别到任何章标题"))).toBe(true)
  })
})

describe("outline-model digest", () => {
  it("内容变化则 digest 变化，updatedAt 变化不影响 digest", async () => {
    const base = buildModel()
    const sameContent = buildModel()
    sameContent.updatedAt = "2030-01-01"
    sameContent.volumes[0].chapters[0].updatedAt = "2030-01-01"

    const changed = buildModel()
    changed.volumes[0].chapters[0].prose.goal = "换一个目标"

    const digestA = await computeOutlineModelDigest(base)
    expect(digestA).toMatch(/^[0-9a-f]{64}$/)
    expect(await computeOutlineModelDigest(sameContent)).toBe(digestA)
    expect(await computeOutlineModelDigest(changed)).not.toBe(digestA)
  })

  it("pov 变化会改变 digest", async () => {
    const base = buildModel()
    const changedPov = buildModel()
    changedPov.volumes[0].chapters[0].pov = "苏七"

    expect(await computeOutlineModelDigest(changedPov)).not.toBe(
      await computeOutlineModelDigest(base),
    )
  })
})

// ── 真实样本 fixtures（每个文件首行注明生产代码来源）────────────────────────
// R-G3-06：解析器与渲染器生产零调用，「vitest 全绿」不能证明真实样本可用，
// 因此样本必须来自生产代码真会产出的形状，而不是为解析器定制的过拟合样本。
const FIXTURE_DIR = resolve(__dirname, "__fixtures__/outline-model-samples")
const FIXTURE_NAMES = [
  "incubator-local-template.md",
  "incubator-llm-prompt-shape.md",
  "volume-title-next-line.md",
  "bold-and-list-headings.md",
  "inline-colon-sections.md",
  "decoy-labels.md",
]

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf-8")
}

describe("outline-model 真实样本回退解析", () => {
  it("硬不变量：最高档 ⇒ warnings 为空且字段填充数 > 0", () => {
    for (const name of FIXTURE_NAMES) {
      const parsed = parseOutlineMarkdownToModel(readFixture(name))
      if (parsed.confidence === "high") {
        expect(parsed.warnings).toEqual([])
        expect(parsed.signals.filledSections).toBeGreaterThan(0)
      }
    }
  })

  it("孵化器本地模板形态可解析出章与标题", () => {
    const parsed = parseOutlineMarkdownToModel(readFixture("incubator-local-template.md"))
    const chapters = flattenOutlineChapters(parsed.model)
    expect(chapters.length).toBeGreaterThanOrEqual(3)
    expect(chapters[0].title.trim().length).toBeGreaterThan(0)
    expect(parsed.signals.chapterHeadings).toBeGreaterThanOrEqual(3)
  })

  it("四类前缀（heading/粗体/列表/裸文本）都识别为章，裸文本正文不误切", () => {
    const parsed = parseOutlineMarkdownToModel(readFixture("bold-and-list-headings.md"))
    const chapters = flattenOutlineChapters(parsed.model)
    // 3 个真章：粗体 `**第1章**` / 列表 `- 第2章` / 有序 `1. 第3章`。
    expect(chapters.map((chapter) => chapter.chapter)).toEqual([1, 2, 3])
    expect(chapters.map((chapter) => chapter.title)).toEqual(["断桥", "旧账", "城门"])
    // 以「。」结尾的长散文与超 50 字的裸文本行都不产生新章。
    expect(parsed.signals.chapterHeadings).toBe(3)
  })

  it("别名与黑名单：干扰标签不落字段，别名各自归位", () => {
    const parsed = parseOutlineMarkdownToModel(readFixture("decoy-labels.md"))
    const chapter = flattenOutlineChapters(parsed.model)[0]

    // 黑名单：读者/地点/基调/人物表不得污染目标、场景、情绪、登场。
    expect(chapter.prose.goal).not.toContain("18-25")
    expect(chapter.prose.scenes).toEqual(["雨夜逼近", "桥心对峙"])
    expect(chapter.prose.emotion).not.toContain("压抑")
    expect(chapter.entities).toEqual(["李慕白左臂受伤"])

    // 别名归位。
    expect(parsed.model.volumes[0].arc).toContain("让两人结下梁子")
    expect(chapter.prose.goal).toContain("第一次交手")
    expect(chapter.prose.emotion).toContain("惊怒")
    expect(chapter.arc).toContain("桥下有人窥视")
    expect(chapter.foreshadow.plant).toContain("FS-001")
    expect(chapter.constraints).toEqual(["苏七本章不出场"])
  })

  it("粗体行内标签（**本章目标**：…）按字段寻址", () => {
    const parsed = parseOutlineMarkdownToModel(readFixture("inline-colon-sections.md"))
    const chapters = flattenOutlineChapters(parsed.model)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].prose.goal).toBe("让两人第一次照面")
    expect(chapters[0].prose.scenes).toEqual(["雨中破桥对峙"])
    expect(chapters[0].entities).toEqual(["李慕白", "苏七"])
    expect(chapters[0].constraints).toEqual(["苏七本章不出场"])
  })

  it("章号夹取：第零章不产出 chapter 0，且记 warning", () => {
    const parsed = parseOutlineMarkdownToModel("### 第零章 引子\n\n### 本章目标\n开场")
    const chapters = flattenOutlineChapters(parsed.model)
    expect(chapters.every((chapter) => chapter.chapter !== 0)).toBe(true)
    expect(parsed.warnings.some((warning) => warning.includes("章号非法：0"))).toBe(true)
  })
})

/**
 * P1 复核修复轮（R-02 / R-09 / R-10 / R-12 / R-24）。
 *
 * 判定标准不是「测试存在」，而是「把被守护的守卫改坏后本组指定 it 必须转红」——
 * 上一轮 review 证明「vitest 全绿」不等于断言有效。
 */
describe("outline-model 解析器权威内容保全（R-02 / R-09 / R-10 / R-12 / R-24）", () => {
  it("第零章与第一章都存活：标题与目标不得被合并销毁（R-02）", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 第零章 引子",
      "### 本章目标",
      "开场",
      "## 第一章 开端",
      "### 本章目标",
      "正式开始",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)
    expect(chapters).toHaveLength(2)
    expect(chapters.map((chapter) => chapter.title).sort()).toEqual(["引子", "开端"].sort())
    const goals = chapters.map((chapter) => chapter.prose.goal).join("|")
    expect(goals).toContain("开场")
    expect(goals).toContain("正式开始")
    // BG-1：显式「第一章」永远拿 1，合成章让位重编号。
    expect(chapters.find((chapter) => chapter.title === "开端")!.chapter).toBe(1)
    expect(parsed.warnings.some((warning) => warning.includes("章号非法：0"))).toBe(true)
  })

  it("序章不整章丢弃，且不夺走第一章的章号（R-10）", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 序章",
      "### 本章目标",
      "开场",
      "## 第1章 开端",
      "### 本章目标",
      "正式开始",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)
    expect(chapters).toHaveLength(2)
    const goals = chapters.map((chapter) => chapter.prose.goal).join("|")
    expect(goals).toContain("开场")
    expect(goals).toContain("正式开始")
    expect(chapters.find((chapter) => chapter.title === "开端")!.chapter).toBe(1)
    expect(parsed.warnings.some((warning) => warning.includes("序章"))).toBe(true)
  })

  it("孵化器真实样本每章字段不得全丢（R-10）", () => {
    for (const name of ["incubator-local-template.md", "incubator-llm-prompt-shape.md"]) {
      const parsed = parseOutlineMarkdownToModel(readFixture(name))
      expect(parsed.signals.filledSections).toBeGreaterThan(0)
      const chapters = flattenOutlineChapters(parsed.model)
      expect(chapters.every((chapter) => chapter.prose.goal.trim().length > 0)).toBe(true)
    }
  })

  it("结构化单章往返无假 warning 且可达 high（R-09）", () => {
    const markdown = renderOutlineChapterToMarkdown(buildModel(), "v01c001")
    const parsed = parseOutlineMarkdownToModel(markdown)
    expect(parsed.warnings).toEqual([])
    expect(parsed.confidence).toBe("high")
    expect(parsed.signals.volumeHeadings).toBe(0)
    // structured 复用已挂载的章，不算新 heading。
    expect(parsed.signals.chapterHeadings).toBe(0)
  })

  it("卷标题续行不吞台词与引用块（R-12）", () => {
    const parsed = parseOutlineMarkdownToModel(readFixture("volume-title-next-line.md"))
    expect(parsed.model.volumes.map((volume) => volume.title)).toEqual(["启程", "第2卷", "第3卷"])
    expect(parsed.model.volumes[1].title).not.toContain("林默")
    expect(parsed.model.volumes[2].title).not.toContain("题材定位")
  })

  it("同一卷标题缺陷只记一条 warning（R-24）", () => {
    const parsed = parseOutlineMarkdownToModel(readFixture("incubator-local-template.md"))
    expect(parsed.warnings.filter((warning) => warning.includes("未识别到卷标题"))).toHaveLength(1)
    expect(parsed.signals.warnings).toBe(parsed.warnings.length)
  })
})

/**
 * P1 复核修复轮（R-07 / R-08 / R-11 / R-20 / R-21 / R-23）。
 *
 * 硬不变量两条子句各自配一条「可命中输入」：旧实现下两条子句结构上够不到，
 * 断言形同虚设（review R-11 的核心结论）。
 */
describe("outline-model 字段归并与置信度真实化（R-07 / R-08 / R-11 / R-20 / R-21 / R-23）", () => {
  it("零 heading 时 fillRate 不饱和：2 个字段不得成 high（R-07）", () => {
    const structured = [
      "---",
      "volume: 1",
      "chapter: 1",
      'title: "断桥"',
      'arc: "相遇"',
      "---",
      "### 本章目标",
      "照面。",
    ].join("\n")
    const parsed = parseOutlineMarkdownToModel(structured)
    expect(parsed.signals.filledSections).toBe(2)
    expect(parsed.signals.chapterCount).toBe(1)
    expect(parsed.confidenceScore).toBeLessThan(0.8)
    expect(parsed.confidence).not.toBe("high")
  })

  it("硬不变量子句一：filledSections === 0 时不得 high（R-11）", () => {
    const parsed = parseOutlineMarkdownToModel("# 第1卷 启程\n## 第1章 断桥")
    expect(parsed.signals.filledSections).toBe(0)
    // 手算：0.2 + 0.25(有章) + 0.2(有卷) + 0.2*(1/1) + 0.25*(0/8) = 0.85
    expect(parsed.confidenceScore).toBeGreaterThanOrEqual(0.8)
    expect(parsed.confidence).not.toBe("high")
  })

  it("硬不变量子句二：warnings 非空时不得 high（R-11）", () => {
    const legacy = [
      "## 第1章 断桥",
      "### 弧线",
      "相遇",
      "### 本章目标",
      "照面",
      "### 场景",
      "- 桥上",
      "### 情绪",
      "紧张",
      "### 登场",
      "- 甲",
      "### 伏笔",
      "- 埋设：FS-001",
      "### 约束",
      "- 乙不出场",
    ].join("\n")
    const parsed = parseOutlineMarkdownToModel(legacy)
    expect(parsed.signals.warnings).toBeGreaterThan(0)
    expect(parsed.signals.filledSections).toBe(7)
    // 手算：0.2 + 0.25 + 0(无卷) + 0.2*(1/1) + 0.25*(7/8) - 0.05*1 = 0.819
    expect(parsed.confidenceScore).toBeGreaterThanOrEqual(0.8)
    expect(parsed.confidence).not.toBe("high")
  })

  it("别名同时命中时不得互相覆盖（R-08）", () => {
    const parsed = parseOutlineMarkdownToModel(readFixture("decoy-labels.md"))
    const chapter = flattenOutlineChapters(parsed.model)[0]
    // 章节定位 + 核心事件 两个别名都指向 prose.goal，覆盖会丢前者。
    expect(chapter.prose.goal).toContain("全书第一个转折点")
    expect(chapter.prose.goal).toContain("两人在断桥上第一次交手")
    expect(chapter.prose.emotion).toContain("警惕")
    expect(chapter.prose.emotion).toContain("惊怒")
    // 合并去重后不得重复堆同一项。
    expect(chapter.prose.scenes).toEqual(["雨夜逼近", "桥心对峙"])
  })

  it("pov 计入 filledSections 且分母为 8 类（R-20）", () => {
    const povOnly = [
      "---",
      "volume: 1",
      "chapter: 1",
      'title: "断桥"',
      'pov: "李慕白"',
      "---",
    ].join("\n")
    expect(parseOutlineMarkdownToModel(povOnly).signals.filledSections).toBe(1)

    const three = [
      "---",
      "volume: 1",
      "chapter: 1",
      'title: "断桥"',
      'pov: "李慕白"',
      'arc: "相遇"',
      "---",
      "### 本章目标",
      "照面。",
    ].join("\n")
    expect(parseOutlineMarkdownToModel(three).signals.filledSections).toBe(3)
  })

  it("重复章号不因输入写法降低分数（R-21）", () => {
    // 结构化单章：heading 数 0、真实章数 1 —— 分母必须取真实章数。
    const structured = [
      "---",
      "volume: 1",
      "chapter: 1",
      'title: "断桥"',
      'arc: "相遇"',
      "---",
      "### 本章目标",
      "照面。",
    ].join("\n")
    const single = parseOutlineMarkdownToModel(structured)
    expect(single.signals.chapterCount).toBe(flattenOutlineChapters(single.model).length)
    expect(single.signals.chapterHeadings).toBe(0)
    // 手算：0.2 + 0.25(有章) + 0(无卷) + 0.2*(1/1) + 0.25*(2/8) = 0.7125 → 0.713
    expect(single.confidenceScore).toBeCloseTo(0.713, 3)

    const duplicated = [
      "# 第1卷 启程",
      "## 第1章 断桥",
      "### 本章目标",
      "照面",
      "## 第1章 断桥",
      "### 本章目标",
      "再照面",
    ].join("\n")
    const twice = parseOutlineMarkdownToModel(duplicated)
    expect(twice.signals.chapterCount).toBe(flattenOutlineChapters(twice.model).length)
    expect(twice.signals.chapterCount).toBe(2)
  })

  it("pov 未规范化值往返后 contentKey 等值（R-23）", () => {
    for (const value of [" 李慕白 ", "李慕白\n", "李慕白\n\n苏七"]) {
      const base = buildModel()
      base.volumes[0].chapters[0].pov = value
      const parsed = parseOutlineMarkdownToModel(renderOutlineModelToMarkdown(base))
      expect(outlineModelContentKey(parsed.model)).toBe(
        outlineModelContentKey(normalizeOutlineModel(base)),
      )
    }
  })

  it("多行 pov 不注入新小节（R-23）", () => {
    const base = buildModel()
    base.volumes[0].chapters[0].pov = "李慕白\n### 场景\n- 被吞掉的场景"
    base.volumes[0].chapters[0].prose.scenes = []
    const parsed = parseOutlineMarkdownToModel(renderOutlineModelToMarkdown(base))
    const chapter = flattenOutlineChapters(parsed.model).find((item) => item.id === "v01c001")!
    expect(chapter.prose.scenes).toEqual([])
    expect(chapter.pov).toContain("场景")
  })
})
