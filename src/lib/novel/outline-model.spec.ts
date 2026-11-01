import { describe, expect, it } from "vitest"
import {
  OUTLINE_MODEL_SCHEMA_VERSION,
  computeOutlineModelDigest,
  findOutlineChapter,
  flattenOutlineChapters,
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
    expect(chapter.arc).toBe("相遇")
    expect(chapter.entities).toEqual(["李慕白", "苏七"])
    expect(chapter.foreshadow).toEqual({ plant: ["FS-001"], payoff: [] })
    expect(chapter.constraints).toEqual(["苏七本章不出场"])
    expect(chapter.prose.scenes).toEqual(["雨中破桥对峙", "剑鞘互击后各自离去"])
  })

  it("找不到章节时抛错", () => {
    expect(() => renderOutlineChapterToMarkdown(buildModel(), "v09c999")).toThrow(/v09c999/)
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
    expect(parsed.confidence).toBe("low")
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
})
