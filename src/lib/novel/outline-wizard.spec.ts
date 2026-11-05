import { describe, expect, it } from "vitest"
import {
  OUTLINE_WIZARD_TASK_OPTIONS,
  OUTLINE_WIZARD_LENGTH_OPTIONS,
  OUTLINE_WIZARD_CHANNEL_OPTIONS,
  OUTLINE_WIZARD_SELLING_POINTS,
  OUTLINE_WIZARD_TARGETS,
  OUTLINE_WIZARD_NARRATIVE_OPTIONS,
  OUTLINE_WIZARD_MATERIAL_OPTIONS,
  getOutlineWizardGenres,
  getOutlineWizardGenreLabel,
  getOutlineWizardValidationError,
  getOutlineWizardSkillNames,
  buildOutlineWizardPrompt,
  type OutlineWizardRequest,
} from "./outline-wizard"

function baseRequest(overrides: Partial<OutlineWizardRequest> = {}): OutlineWizardRequest {
  return {
    task: "newBook",
    length: "long",
    channel: "male",
    genre: "dushi",
    customGenre: "",
    inspiration: "一个外卖员获得系统",
    sellingPoints: ["升级变强"],
    targets: ["总纲"],
    scale: "",
    narrative: "thirdPerson",
    materialSource: "none",
    ...overrides,
  }
}

describe("选项常量", () => {
  it("任务/篇幅/频道/叙事/资料选项标签完整", () => {
    expect(OUTLINE_WIZARD_TASK_OPTIONS.map((o) => o.value)).toEqual([
      "newBook",
      "fromExisting",
      "volumeOutline",
      "chapterOutline",
      "modifyOutline",
      "fillMissing",
    ])
    expect(OUTLINE_WIZARD_LENGTH_OPTIONS).toHaveLength(4)
    expect(OUTLINE_WIZARD_CHANNEL_OPTIONS).toHaveLength(3)
    expect(OUTLINE_WIZARD_NARRATIVE_OPTIONS.map((o) => o.value)).toEqual([
      "firstPerson",
      "thirdPerson",
      "multiPov",
      "auto",
    ])
    expect(OUTLINE_WIZARD_MATERIAL_OPTIONS.map((o) => o.value)).toEqual([
      "none",
      "project",
      "pasteLater",
    ])
    expect(OUTLINE_WIZARD_SELLING_POINTS).toContain("悬疑反转")
    expect(OUTLINE_WIZARD_TARGETS).toContain("章纲")
  })
})

describe("getOutlineWizardGenres", () => {
  it("男频返回男频题材且含 custom", () => {
    const genres = getOutlineWizardGenres("male")
    expect(genres.map((g) => g.value)).toContain("dushi")
    expect(genres.map((g) => g.value)).toContain("custom")
    expect(genres.find((g) => g.value === "dushi")?.label).toBe("都市")
  })

  it("女频返回女频题材", () => {
    const genres = getOutlineWizardGenres("female")
    expect(genres.map((g) => g.value)).toContain("xianyan")
    expect(genres.find((g) => g.value === "guyan")?.label).toBe("古言")
  })

  it("auto 返回混合列表且首项为待定", () => {
    const genres = getOutlineWizardGenres("auto")
    expect(genres[0]).toEqual({ value: "auto", label: "暂不确定，让 AI 根据灵感判断" })
    expect(genres.map((g) => g.value)).toContain("dushi")
    expect(genres.map((g) => g.value)).toContain("xianyan")
    expect(genres[genres.length - 1].value).toBe("custom")
  })
})

describe("getOutlineWizardGenreLabel", () => {
  it("custom 题材返回用户输入", () => {
    expect(
      getOutlineWizardGenreLabel({ channel: "male", genre: "custom", customGenre: "  废土种田  " }),
    ).toBe("废土种田")
  })

  it("custom 为空时返回其他", () => {
    expect(
      getOutlineWizardGenreLabel({ channel: "male", genre: "custom", customGenre: "   " }),
    ).toBe("其他")
  })

  it("命中选项时返回选项标签", () => {
    expect(
      getOutlineWizardGenreLabel({ channel: "male", genre: "dushi", customGenre: "" }),
    ).toBe("都市")
    expect(
      getOutlineWizardGenreLabel({ channel: "auto", genre: "auto", customGenre: "" }),
    ).toBe("暂不确定，让 AI 根据灵感判断")
  })

  it("男女频未知题材回退到主分类标签", () => {
    expect(
      getOutlineWizardGenreLabel({ channel: "male", genre: "junshi", customGenre: "" }),
    ).toBe("军事")
  })

  it("男女频完全未知题材原样返回", () => {
    expect(
      getOutlineWizardGenreLabel({ channel: "female", genre: "no-such-genre", customGenre: "" }),
    ).toBe("no-such-genre")
  })

  it("auto 频道未知题材原样返回", () => {
    expect(
      getOutlineWizardGenreLabel({ channel: "auto", genre: "mystery-x", customGenre: "" }),
    ).toBe("mystery-x")
  })
})

describe("getOutlineWizardValidationError", () => {
  it("灵感为空时报错", () => {
    expect(getOutlineWizardValidationError(baseRequest({ inspiration: "   " }))).toBe(
      "请先填写故事灵感或处理要求。",
    )
  })

  it("custom 题材未填写时报错", () => {
    expect(
      getOutlineWizardValidationError(baseRequest({ genre: "custom", customGenre: " " })),
    ).toBe("请选择题材或填写自定义题材。")
  })

  it("未选生成目标时报错", () => {
    expect(getOutlineWizardValidationError(baseRequest({ targets: [] }))).toBe(
      "请至少选择一个生成目标。",
    )
  })

  it("校验顺序：灵感优先于题材与目标", () => {
    expect(
      getOutlineWizardValidationError(
        baseRequest({ inspiration: "", genre: "custom", customGenre: "", targets: [] }),
      ),
    ).toBe("请先填写故事灵感或处理要求。")
  })

  it("合法请求返回 null", () => {
    expect(getOutlineWizardValidationError(baseRequest())).toBeNull()
    expect(
      getOutlineWizardValidationError(
        baseRequest({ genre: "custom", customGenre: "废土" }),
      ),
    ).toBeNull()
  })
})

describe("getOutlineWizardSkillNames", () => {
  it("已知题材带出主题技能与配套技能", () => {
    const names = getOutlineWizardSkillNames(baseRequest({ genre: "dushi" }))
    expect(names).toContain("outline-master-builder")
    expect(names).toContain("male-urban-highmartial")
    expect(names).toContain("power-system")
    expect(names).toContain("map-progression")
    expect(names).toContain("combat-action")
  })

  it("未知题材回退到市场与人物技能", () => {
    const names = getOutlineWizardSkillNames(baseRequest({ genre: "no-such-genre" }))
    expect(names).toContain("idea-market-positioning")
    expect(names).toContain("character-design")
    expect(names).not.toContain("power-system")
  })

  it("目标含章纲时追加装配与契合技能", () => {
    const names = getOutlineWizardSkillNames(baseRequest({ targets: ["章纲"] }))
    expect(names).toContain("outline-final-assembler")
    expect(names).toContain("protagonist-plot-fit")
  })

  it("目标不含章纲时不追加", () => {
    const names = getOutlineWizardSkillNames(baseRequest({ targets: ["总纲"] }))
    expect(names).not.toContain("outline-final-assembler")
    expect(names).not.toContain("protagonist-plot-fit")
  })

  it("短篇/中短篇追加短篇技能", () => {
    expect(getOutlineWizardSkillNames(baseRequest({ length: "short" }))).toContain(
      "short-form-drafting",
    )
    expect(getOutlineWizardSkillNames(baseRequest({ length: "mediumShort" }))).toContain(
      "short-form-drafting",
    )
    expect(getOutlineWizardSkillNames(baseRequest({ length: "long" }))).not.toContain(
      "short-form-drafting",
    )
  })

  it("技能名去重", () => {
    const names = getOutlineWizardSkillNames(
      baseRequest({ genre: "zhihuduanpian", length: "short", targets: ["章纲"] }),
    )
    expect(names).toContain("zhihu-short")
    expect(names).toContain("short-form-drafting")
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("buildOutlineWizardPrompt", () => {
  it("标准模式包含需求、技能与固定工作流", () => {
    const prompt = buildOutlineWizardPrompt(
      baseRequest({ genre: "custom", customGenre: "废土种田", scale: "长篇百万字" }),
    )
    expect(prompt).toContain("创建新书大纲")
    expect(prompt).toContain("长篇小说")
    expect(prompt).toContain("男频")
    expect(prompt).toContain("废土种田")
    expect(prompt).toContain("一个外卖员获得系统")
    expect(prompt).toContain("升级变强")
    expect(prompt).toContain("长篇百万字")
    expect(prompt).toContain("## 本次优先调用 Skill")
    expect(prompt).toContain("1. outline-master-builder")
    expect(prompt).toContain("## 固定工作流")
    expect(prompt).toContain("先卷后章")
  })

  it("空卖点/空规模时使用 AI 推荐文案", () => {
    const prompt = buildOutlineWizardPrompt(baseRequest({ sellingPoints: [] }))
    expect(prompt).toContain("AI 根据灵感推荐")
    expect(prompt).toContain("AI 根据篇幅和题材推荐")
  })

  it("fast 模式直接要正文且不带工作流", () => {
    const prompt = buildOutlineWizardPrompt(baseRequest(), { mode: "fast" })
    expect(prompt).toContain("直接生成可保存的大纲正文")
    expect(prompt).not.toContain("## 固定工作流")
    expect(prompt).not.toContain("## 本次优先调用 Skill")
  })

  it("未知枚举值回退为原值", () => {
    const prompt = buildOutlineWizardPrompt(
      baseRequest({
        task: "unknown-task" as never,
        narrative: "unknown" as never,
        materialSource: "unknown" as never,
      }),
    )
    expect(prompt).toContain("unknown-task")
  })

  it("多卖点与多目标用顿号连接", () => {
    const prompt = buildOutlineWizardPrompt(
      baseRequest({ sellingPoints: ["升级变强", "打脸逆袭"], targets: ["总纲", "章纲"] }),
    )
    expect(prompt).toContain("升级变强、打脸逆袭")
    expect(prompt).toContain("总纲、章纲")
  })
})
