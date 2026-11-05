import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  OUTLINE_MODEL_SCHEMA_VERSION,
  computeOutlineModelDigest,
  emptyOutlineModel,
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
  renderOutlineChapterByPosition,
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

/**
 * 第二轮复核微修（N-01 / N-02 / N-03 / N-04）。
 *
 * 判定标准同前轮：每条用例必须「把被守护的守卫改回错误实现后转红」——
 * 变异自检记录在 run 的 outputs/self-check.json。
 */
describe("outline-model 解析器微修（N-01 / N-02 / N-03 / N-04）", () => {
  it("「楔子」是序章别名：标题与目标都存活，且不夺走第1章的号（N-01）", () => {
    const legacy = [
      "# 第1卷 启程",
      "### 楔子",
      "夜雨，断桥。",
      "## 第1章 开端",
      "### 本章目标",
      "正式开始",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)
    // 旧实现把「楔子」写成「榉子」（U+6989 ≠ U+6954），整章静默丢失只剩 1 章。
    expect(chapters).toHaveLength(2)
    const prologue = chapters.find((chapter) => chapter.title === "楔子")!
    expect(prologue).toBeDefined()
    expect(prologue.prose.goal).toBe("夜雨，断桥。")
    expect(parsed.warnings.some((warning) => warning.includes("楔子"))).toBe(true)
    // BG-1：显式「第1章」拿 1，合成章让位。
    expect(chapters.find((chapter) => chapter.title === "开端")!.chapter).toBe(1)
    // 文档序（= 数组序 = 渲染序）：序章在首位。
    expect(parsed.model.volumes[0].chapters[0].title).toBe("楔子")
    // 单字「楔」也接受（旧实现两处正则都只认错字）。
    const single = parseOutlineMarkdownToModel("# 第1卷 启程\n### 楔\n夜雨。\n## 第1章 开端")
    expect(flattenOutlineChapters(single.model).map((chapter) => chapter.title)).toContain("楔")
  })

  it("章后摘要只吃紧邻首个散文行：台词/引用/表格/围栏/分隔线/单级标题都不进 goal（N-02）", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 第1章 台词",
      "**苏七**：你真的要走？",
      "## 第2章 引用",
      "> 引用块",
      "## 第3章 表格",
      "| 列 | 值 |",
      "## 第4章 围栏",
      "```ts",
      "const x = 1",
      "```",
      "## 第5章 分隔线",
      "---",
      "## 第6章 单级标题",
      "# 卷外附录",
      "## 第7章 多行散文",
      "第一段摘要。",
      "第二段不该被吸进目标。",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)
    expect(chapters).toHaveLength(7)
    const byTitle = new Map(chapters.map((chapter) => [chapter.title, chapter]))
    for (const title of ["台词", "引用", "表格", "围栏", "分隔线", "单级标题"]) {
      expect(byTitle.get(title)!.prose.goal).toBe("")
    }
    // 只吃第一个非空行：第二段散文不得被追加进 goal。
    expect(byTitle.get("多行散文")!.prose.goal).toBe("第一段摘要。")
    // 结构标记不是字段填充：不得因此抬高 filledSections（旧实现这里是 7）。
    expect(parsed.signals.filledSections).toBe(1)
    // 分档区分力（fillRate 入 high 判定）属 N-05，本轮 deferred —— 此处只断言字段不被污染。
  })

  it("序章 + 第1..3章：每个显式章拿自己的号，合成章不再连锁位移（N-03）", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 序章",
      "### 本章目标",
      "开场",
      "## 第1章 开端",
      "### 本章目标",
      "正式开始",
      "## 第2章 旧账",
      "### 本章目标",
      "清算旧账",
      "## 第3章 城门",
      "### 本章目标",
      "进城",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)
    expect(chapters).toHaveLength(4)
    const byTitle = new Map(chapters.map((chapter) => [chapter.title, chapter]))
    // 旧实现：序章让位后丢掉 synthetic 身份 → 第2章→3、第3章→4 连锁位移。
    expect(byTitle.get("开端")!.chapter).toBe(1)
    expect(byTitle.get("旧账")!.chapter).toBe(2)
    expect(byTitle.get("城门")!.chapter).toBe(3)
    expect(byTitle.get("序章")!.prose.goal).toBe("开场")
    // 文档序（= 数组序 = 渲染序）首位是序章；章号不撞号（validate 无 issue）。
    // 注：flatten 按章号升序排序，而 validate 只接受正整数章号（chapter 0 非法），
    // 合成章让位后只能取 >3 的号，因此 flatten 序必然是显式章在前。
    expect(parsed.model.volumes[0].chapters[0].title).toBe("序章")
    expect(new Set(chapters.map((chapter) => chapter.chapter)).size).toBe(4)
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
  })

  it("正文里单独成段的「引子」「番外」不成章（N-04）", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 第1章 断桥",
      "两人第一次照面。",
      "## 第2章 旧账",
      "清算旧账。",
      "引子",
      "番外",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)
    // 旧实现：正文段落里的「引子」「番外」被无条件提升为章标题（章数变 4）。
    expect(chapters).toHaveLength(2)
    expect(chapters.map((chapter) => chapter.title)).toEqual(["断桥", "旧账"])
  })
})

/**
 * s5-autotest 补测试轮：R-02 的 partially_fixed 剩余面 —— 章号语义边界。
 *
 * R-02 已修的是「第零章正文被静默销毁 + 静默合并」；本轮补的是**边界值语义**：
 * 第零章 / 超大章号 / 负章号 / 卷号越界各自走哪条路（显式编号 vs 合成编号 vs 不识别），
 * 以及夹取后的 id / volume 归属 / validate 结果是否自洽。错误实现会红。
 */
describe("outline-model 章号语义边界矩阵（R-02 剩余面：第零章 / 负章号 / 超大章号 / 卷号越界）", () => {
  it("第零章 + 第1章 + 第2章：显式章各拿自己的号，合成章让位到 3，三章内容全存活", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 第零章 引子",
      "引子摘要。",
      "## 第1章 开端",
      "开端摘要。",
      "## 第2章 发展",
      "发展摘要。",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)

    expect(chapters).toHaveLength(3)
    // 显式号永不被合成章夺走（BG-1），合成章只能取 max+1。
    expect(chapters.map((chapter) => chapter.chapter)).toEqual([1, 2, 3])
    expect(chapters.map((chapter) => chapter.title)).toEqual(["开端", "发展", "引子"])
    // 三章正文各自存活：任何一章被合并/销毁都会让这条断言丢内容。
    expect(chapters.map((chapter) => chapter.prose.goal)).toEqual([
      "开端摘要。",
      "发展摘要。",
      "引子摘要。",
    ])
    // 夹取后模型仍自洽：章号不撞号、id 与章号一致。
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
    expect(chapters[2].id).toBe(outlineChapterId(1, 3))
    // 第零章记「非法」，两次让位各记一条（不静默）。
    expect(parsed.warnings.some((warning) => warning.includes("章号非法：0"))).toBe(true)
    expect(parsed.warnings.filter((warning) => warning.includes("章号冲突"))).toHaveLength(2)
  })

  it("超大章号 1000（heading）：不产出 chapter 1000，改合成编号且记 warning", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 第1000章 巨章",
      "巨章摘要。",
      "## 第1章 开端",
      "开端摘要。",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)

    expect(chapters.some((chapter) => chapter.chapter === 1000)).toBe(false)
    expect(chapters.map((chapter) => chapter.chapter)).toEqual([1, 2])
    expect(chapters.map((chapter) => chapter.title)).toEqual(["开端", "巨章"])
    expect(parsed.warnings.some((warning) => warning.includes("章号非法：1000"))).toBe(true)
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
  })

  it("边界 999：仍在显式区间内，chapter 与 id 原样保留（夹取上限不越界）", () => {
    const parsed = parseOutlineMarkdownToModel(["# 第1卷 启程", "## 第999章 边缘", "正文。"].join("\n"))
    const chapters = flattenOutlineChapters(parsed.model)

    expect(chapters).toHaveLength(1)
    expect(chapters[0].chapter).toBe(999)
    expect(chapters[0].id).toBe("v01c999")
    expect(parseOutlineChapterId(chapters[0].id)).toEqual({ volume: 1, chapter: 999 })
    expect(parsed.warnings.some((warning) => warning.includes("章号非法"))).toBe(false)
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
  })

  it("负章号（heading 形态）不产出任何章，也不静默变成第 1 章", () => {
    const legacy = [
      "# 第1卷 启程",
      "## 第-1章 负章",
      "负章摘要。",
      "## 第1章 开端",
      "开端摘要。",
    ].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)

    // 正则只认正数字面：负号不构成章号 ⇒ 不识别为章标题，也不会被夹取成 1。
    expect(chapters).toHaveLength(1)
    expect(chapters[0].chapter).toBe(1)
    expect(chapters[0].title).toBe("开端")
    expect(chapters.every((chapter) => chapter.chapter > 0)).toBe(true)
    expect(parsed.warnings.every((warning) => !warning.includes("-1"))).toBe(true)
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
  })

  it("卷号越界（0 / 1000）：回落为 1，且章归属与 id 同步（validate ok）", () => {
    for (const [heading, raw, expectedTitle] of [
      ["## 第0卷 零卷", "0", "零卷"],
      ["## 第1000卷 巨卷", "1000", "巨卷"],
    ] as const) {
      const parsed = parseOutlineMarkdownToModel([heading, "### 第1章 开端", "开端摘要。"].join("\n"))
      const volume = parsed.model.volumes[0]
      expect(parsed.model.volumes).toHaveLength(1)
      expect(volume.number).toBe(1)
      expect(volume.title).toBe(expectedTitle)
      expect(volume.chapters[0].volume).toBe(1)
      expect(volume.chapters[0].id).toBe(outlineChapterId(1, 1))
      expect(parsed.warnings.some((warning) => warning.includes(`卷号非法：${raw}`))).toBe(true)
      expect(validateOutlineModel(parsed.model).ok).toBe(true)
    }
  })

  it("负卷号不伪造第 0 卷：回落第 1 卷 + 卷标题缺陷 warning", () => {
    const parsed = parseOutlineMarkdownToModel(["## 第-1卷 负卷", "### 第1章 开端", "开端摘要。"].join("\n"))

    expect(parsed.model.volumes).toHaveLength(1)
    expect(parsed.model.volumes[0].number).toBe(1)
    expect(parsed.model.volumes.every((volume) => volume.number > 0)).toBe(true)
    expect(parsed.warnings.some((warning) => warning.includes("未识别到卷标题"))).toBe(true)
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
  })

  it("结构化 frontmatter 负章号：不把 -1 静默改写成第 1 章", () => {
    const legacy = ["---", "volume: 1", "chapter: -1", 'title: "倒叙"', "---", "", "# 倒叙", ""].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)

    expect(chapters).toHaveLength(0)
    expect(parsed.warnings.some((warning) => warning.includes("未识别到任何章标题"))).toBe(true)
    // 空模型是合法模型：不得为了「看起来成功」造一个 chapter 1 出来。
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
  })
})

/**
 * s5-autotest 补测试轮：R-10 的 partially_fixed 剩余面 —— 章标题变体矩阵。
 *
 * R-10 已修的是「序章整章丢弃 + 假 high」；本轮把「无编号章标题词 × 书写形态」的
 * 笛卡尔积逐格钉死：8 个词 × 4 种形态（heading / 粗体 / 列表 / 裸文本）都必须成章、
 * 必须保住摘要、必须不夺走显式「第1章」的号。任一格回退到「整章丢弃」即转红。
 */
const SPECIAL_CHAPTER_WORDS = ["序章", "序幕", "楔子", "楔", "引子", "终章", "尾声", "番外"] as const

const SPECIAL_CHAPTER_FORMS: Array<{ form: string; line: (word: string) => string }> = [
  { form: "heading", line: (word) => `## ${word}` },
  { form: "bold", line: (word) => `**${word}**` },
  { form: "list", line: (word) => `- ${word}` },
  { form: "bare", line: (word) => word },
]

describe("outline-model 章标题变体矩阵（R-10 剩余面：8 词 × 4 形态）", () => {
  it.each(
    SPECIAL_CHAPTER_WORDS.flatMap((word) =>
      SPECIAL_CHAPTER_FORMS.map(({ form, line }) => ({ word, form, line })),
    ),
  )("$word（$form）：成章、保住摘要、不夺走第1章的号", ({ word, form, line }) => {
    const legacy = ["# 第1卷 启程", line(word), `${word}摘要。`, "## 第1章 开端", "开端摘要。"].join("\n")

    const parsed = parseOutlineMarkdownToModel(legacy)
    const chapters = flattenOutlineChapters(parsed.model)

    // 旧实现：这些词一个都认不出 ⇒ 章数 1、摘要整段丢弃。
    expect(chapters).toHaveLength(2)
    const special = chapters.find((chapter) => chapter.title === word)
    expect(special, `${form} 形态的「${word}」没有成章`).toBeDefined()
    expect(special!.prose.goal).toContain(`${word}摘要`)
    // BG-1：显式「第1章」永远拿 1，无编号词只能拿合成号。
    expect(chapters.find((chapter) => chapter.title === "开端")!.chapter).toBe(1)
    expect(special!.chapter).not.toBe(1)
    expect(parsed.warnings.some((warning) => warning.includes(`未识别到章号：${word}`))).toBe(true)
    expect(validateOutlineModel(parsed.model).ok).toBe(true)
  })

  it("变体矩阵：冒号/空格分隔的副标题写进 title，标签词本身不污染 title", () => {
    const colon = parseOutlineMarkdownToModel(["# 第1卷 启程", "## 序章：血月", "序章摘要。"].join("\n"))
    const colonChapter = flattenOutlineChapters(colon.model)[0]
    expect(colonChapter.title).toBe("血月")
    expect(colonChapter.prose.goal).toBe("序章摘要。")

    const space = parseOutlineMarkdownToModel(["# 第1卷 启程", "## 楔子 血月", "楔子摘要。"].join("\n"))
    const spaceChapter = flattenOutlineChapters(space.model)[0]
    expect(spaceChapter.title).toBe("血月")
    expect(spaceChapter.prose.goal).toBe("楔子摘要。")
  })
})

/**
 * s5-autotest 补测试轮：N-05 的「可保部分」。
 *
 * N-05 的实质缺陷（high 档实际只由 filledSections>0 决定、5/8 与 8/8 同分）需要改分档
 * 公式才能断言，会直接转红，故记入 report concerns。这里只钉住当前**成立且应当成立**
 * 的两条性质：取值范围 [0,1] 与「多填一个字段不得降分」。
 */
describe("outline-model 置信度取值范围与单调性（N-05 可保部分）", () => {
  const SECTION_BLOCKS = [
    ["本章目标", "照面。"],
    ["弧线", "相遇"],
    ["视角", "李慕白"],
    ["场景", "- 雨中破桥对峙"],
    ["情绪", "紧张"],
    ["登场", "- 李慕白"],
    ["伏笔", "埋设 FS-001"],
    ["约束", "- 苏七本章不出场"],
  ] as const

  it("confidenceScore 恒在 [0,1]，且填充字段递增时不得降分", () => {
    const scores: number[] = []
    for (let count = 0; count <= SECTION_BLOCKS.length; count += 1) {
      const body = SECTION_BLOCKS.slice(0, count).flatMap(([label, text]) => [`### ${label}`, text])
      const markdown = ["# 第1卷 启程", "## 第1章 断桥", ...body].join("\n")
      scores.push(parseOutlineMarkdownToModel(markdown).confidenceScore)
    }

    for (const score of scores) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]).toBeGreaterThanOrEqual(scores[index - 1])
    }
    // 全空不得与全满同分（否则量化信号彻底失效）。
    expect(scores[scores.length - 1]).toBeGreaterThan(scores[0])
  })
})

describe("outline-model 覆盖增补：parseOutlineChapterId 非有限数与空骨架", () => {
  it("超大数字溢出 Infinity → null（Number.isFinite 守卫）", () => {
    expect(parseOutlineChapterId(`v${"9".repeat(400)}c001`)).toBeNull()
  })

  it("非法锚点返回 null", () => {
    expect(parseOutlineChapterId("nope")).toBeNull()
    expect(parseOutlineChapterId("v1c001")).toBeNull()
  })

  it("emptyOutlineModel 返回带版本号的空骨架", () => {
    const model = emptyOutlineModel("2026-11-01")
    expect(model.schemaVersion).toBe(OUTLINE_MODEL_SCHEMA_VERSION)
    expect(model.volumes).toEqual([])
    expect(model.updatedAt).toBe("2026-11-01")
    expect(validateOutlineModel(model).ok).toBe(true)
  })
})

describe("outline-model 覆盖增补：validateOutlineModel 全坏模型一次收齐", () => {
  it("根节点非对象直接拒收", () => {
    for (const bad of [null, undefined, "oops", 42, []]) {
      const res = validateOutlineModel(bad as unknown as OutlineModel)
      expect(res.ok).toBe(false)
      expect(res.issues).toEqual(["模型根节点不是对象"])
    }
  })

  it("volumes 非数组早退（R-03 TypeError 源）", () => {
    const res = validateOutlineModel({ schemaVersion: 2, volumes: "x", updatedAt: "t" } as unknown as OutlineModel)
    expect(res.ok).toBe(false)
    expect(res.issues).toContain("volumes 不是数组")
  })

  it("全坏模型收集全部问题而不抛异常", () => {
    const bad = {
      schemaVersion: "2",
      volumes: [
        null,
        { number: 0, title: 123, arc: null, chapters: "x" },
        {
          number: 1,
          title: "t",
          arc: "a",
          chapters: [
            null,
            {
              id: "nope",
              volume: 2,
              chapter: 0,
              title: 5,
              entities: [1],
              constraints: "x",
              pov: 1,
              arc: null,
              prose: "oops",
              foreshadow: 42,
            },
            {
              id: "v01c002",
              volume: 1,
              chapter: 2,
              title: "ok",
              entities: [],
              constraints: [],
              pov: "",
              arc: "",
              prose: { goal: 1, scenes: [2], emotion: null },
              foreshadow: { plant: [3], payoff: "p" },
            },
          ],
        },
        { number: 1, title: "dup", arc: "a", chapters: [] },
      ],
      updatedAt: "t",
    } as unknown as OutlineModel
    let res: ReturnType<typeof validateOutlineModel> | undefined
    expect(() => {
      res = validateOutlineModel(bad)
    }).not.toThrow()
    expect(res!.ok).toBe(false)
    const joined = res!.issues.join("\n")
    for (const needle of [
      "schemaVersion 缺失或非数字",
      "卷节点不是对象",
      "卷号非法：0",
      "卷 0 的 title 必须是字符串",
      "卷 0 的 arc 必须是字符串",
      "卷 0 的 chapters 不是数组",
      "章节点不是对象",
      "章号非法：v1c0",
      "id 与卷章号不一致：nope",
      "章归属卷号不一致：nope 声明 2，实际在 1",
      "章标题类型非法：v1c0",
      "v1c0 的 entities 必须是 string[]",
      "v1c0 的 constraints 必须是 string[]",
      "v1c0 的 pov 必须是字符串",
      "v1c0 的 arc 必须是字符串",
      "v1c0 的 prose 必须是对象",
      "v1c0 的 foreshadow 必须是对象",
      "v1c2 的 prose.goal 必须是字符串",
      "v1c2 的 prose.scenes 必须是 string[]",
      "v1c2 的 prose.emotion 必须是字符串",
      "v1c2 的 foreshadow.plant 必须是 string[]",
      "v1c2 的 foreshadow.payoff 必须是 string[]",
      "卷号重复：1",
    ]) {
      expect(joined).toContain(needle)
    }
  })
})

describe("outline-model-render 覆盖增补：按位置渲染 / 可选字段边界", () => {
  it("renderOutlineChapterByPosition 命中时与按 id 渲染逐字节一致（options 走默认值）", () => {
    const model = buildModel()
    expect(renderOutlineChapterByPosition(model, 1, 1)).toBe(
      renderOutlineChapterToMarkdown(model, outlineChapterId(1, 1)),
    )
    expect(renderOutlineChapterByPosition(model, 1, 1)).toContain("# 第1章 断桥")
  })

  it("renderOutlineChapterByPosition 未命中返回 null（不抛错）", () => {
    expect(renderOutlineChapterByPosition(buildModel(), 9, 9)).toBeNull()
    expect(renderOutlineChapterByPosition(buildModel(), 1, 99)).toBeNull()
  })

  it("单章渲染写入 digest；不传则不写该 frontmatter 行", () => {
    const withDigest = renderOutlineChapterToMarkdown(buildModel(), "v01c001", { digest: "d1g3st" })
    expect(withDigest).toContain("outline_model_digest: d1g3st")
    expect(renderOutlineChapterToMarkdown(buildModel(), "v01c001")).not.toContain(
      "outline_model_digest",
    )
  })

  it("模型/章节 updatedAt 为空时省略 outline_updated_at（不写空值行）", () => {
    const model = buildModel()
    model.updatedAt = ""
    model.volumes[0].chapters[0].updatedAt = ""
    expect(renderOutlineModelToMarkdown(model)).not.toContain("outline_updated_at")
    expect(renderOutlineChapterToMarkdown(model, "v01c001")).not.toContain("outline_updated_at")
  })

  it("章节无伏笔（埋设/回收都为空）→ 不渲染「伏笔」小节", () => {
    const model = buildModel()
    model.volumes[0].chapters[0].foreshadow = { plant: [], payoff: [] }
    const markdown = renderOutlineChapterToMarkdown(model, "v01c001")
    expect(markdown).not.toContain("### 伏笔")
    expect(markdown).not.toContain("foreshadow_plant")
    expect(markdown).not.toContain("foreshadow_payoff")
  })

  it("卷标题为空 → 省略 volume_title（不凭空造卷名）", () => {
    const model = buildModel()
    model.volumes[0].title = ""
    const markdown = renderOutlineChapterToMarkdown(model, "v01c001")
    expect(markdown).not.toContain("volume_title")
    expect(markdown).toContain('title: "断桥"')
  })

  it("章节无登场实体 → 省略 entities frontmatter 行与「登场」小节", () => {
    const model = buildModel()
    model.volumes[0].chapters[0].entities = []
    const markdown = renderOutlineChapterToMarkdown(model, "v01c001")
    expect(markdown).not.toContain("entities:")
    expect(markdown).not.toContain("### 登场")
  })
})
