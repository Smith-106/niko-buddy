/**
 * 工作流/大纲模板注册表：只读登记的行为证据（**断言可失败**）。
 *
 * 覆盖面：必填字段数量/名称与真源常量一致、枚举取值与真源一致、码点序分组与排序、
 * 渲染失败降级（error 而非空串）、无渲染函数的显式 N/A、stage 清单与联合类型一致、确定性。
 */
import { describe, expect, it } from "vitest"
import {
  CHAPTER_BLUEPRINT_FIELDS,
  CHAPTER_END_HOOK_TYPES,
  CHAPTER_HOOK_TYPES,
  CHAPTER_OUTLINE_REQUIRED_SECTIONS,
  CHAPTER_POSITION_TYPES,
  getChapterOutlineTemplate,
  getVolumeOutlineTemplate,
  VOLUME_OUTLINE_REQUIRED_FIELDS,
} from "./outline-templates"
import {
  groupWorkflowTemplates,
  hasFieldLine,
  listWorkflowTemplateRegistry,
  NOVEL_SKILL_STAGES,
  type WorkflowTemplateEntry,
} from "./workflow-template-registry"

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function entryOf(entries: readonly WorkflowTemplateEntry[], id: string): WorkflowTemplateEntry {
  const found = entries.find((entry) => entry.id === id)
  if (!found) throw new Error(`注册表缺少条目 ${id}`)
  return found
}

describe("listWorkflowTemplateRegistry", () => {
  it("必填字段数量与名称与真源常量逐字一致（volume / 章纲 / 蓝图）", () => {
    const entries = listWorkflowTemplateRegistry()

    const volume = entryOf(entries, "volume-outline")
    expect(volume.requiredFieldCount).toBe(VOLUME_OUTLINE_REQUIRED_FIELDS.length)
    expect(volume.requiredFields).toEqual([...VOLUME_OUTLINE_REQUIRED_FIELDS])
    expect(volume.requiredFieldCount).toBe(6)

    const chapter = entryOf(entries, "chapter-outline")
    expect(chapter.requiredFieldCount).toBe(CHAPTER_OUTLINE_REQUIRED_SECTIONS.length)
    expect(chapter.requiredFields).toEqual([...CHAPTER_OUTLINE_REQUIRED_SECTIONS])
    expect(chapter.requiredFieldCount).toBe(15)

    const blueprint = entryOf(entries, "chapter-blueprint")
    expect(blueprint.requiredFieldCount).toBe(CHAPTER_BLUEPRINT_FIELDS.length)
    expect(blueprint.requiredFields).toEqual([...CHAPTER_BLUEPRINT_FIELDS])
    expect(blueprint.requiredFieldCount).toBe(9)

    for (const entry of entries) {
      expect(entry.requiredFieldCount).toBe(entry.requiredFields.length)
    }
  })

  it("枚举清单与取值与真源常量一致，枚举计数自洽", () => {
    const entries = listWorkflowTemplateRegistry()

    const chapter = entryOf(entries, "chapter-outline")
    expect(chapter.enums.map((ref) => ref.name)).toEqual([
      "CHAPTER_HOOK_TYPES",
      "CHAPTER_END_HOOK_TYPES",
    ])
    expect(chapter.enums[0]?.values).toEqual([...CHAPTER_HOOK_TYPES])
    expect(chapter.enums[1]?.values).toEqual([...CHAPTER_END_HOOK_TYPES])
    expect(chapter.enums[0]?.linkedField).toBe("章首钩子")
    expect(chapter.enums[1]?.linkedField).toBe("章尾钩子")
    expect(chapter.enumListCount).toBe(2)
    expect(chapter.enumValueCount).toBe(CHAPTER_HOOK_TYPES.length + CHAPTER_END_HOOK_TYPES.length)

    const position = entryOf(entries, "chapter-position-types")
    expect(position.enums[0]?.values).toEqual([...CHAPTER_POSITION_TYPES])
    expect(position.enumValueCount).toBe(6)
    // 与章纲模板「章节定位：开篇 / 推进 / …」取值不一致 → 明确不链接（不假装挂上）。
    expect(position.enums[0]?.linkedField).toBeNull()

    for (const entry of entries) {
      expect(entry.enumListCount).toBe(entry.enums.length)
      expect(entry.enumValueCount).toBe(
        entry.enums.reduce((sum, ref) => sum + ref.values.length, 0),
      )
      for (const ref of entry.enums) expect(ref.valueCount).toBe(ref.values.length)
    }
  })

  it("真源自证：卷纲模板缺「爽点节奏/伏笔布局/关键反转」→ 如实列入，不补内容", () => {
    const volume = entryOf(listWorkflowTemplateRegistry(), "volume-outline")
    // 真源当前确实只有「本卷伏笔」「爽点节奏表」「本卷关键反转」——如实暴露，不替真源补字。
    // 整词/标题行匹配（不是裸子串）：「爽点节奏表」「本卷关键反转」都不算声明了
    // 「爽点节奏」「关键反转」，故三者都如实列入缺失——审查修正后的口径。
    expect(volume.missingRequiredFieldNames).toEqual(["爽点节奏", "伏笔布局", "关键反转"])
  })

  it("章纲/蓝图字段名全部出现在渲染正文里（missing 为空数组，而非 null）", () => {
    const entries = listWorkflowTemplateRegistry()
    const chapter = entryOf(entries, "chapter-outline")
    expect(chapter.missingRequiredFieldNames).toEqual([])
    const chapterText = getChapterOutlineTemplate(1, "«title»")
    for (const field of CHAPTER_OUTLINE_REQUIRED_SECTIONS) expect(chapterText).toContain(field)
  })

  it("正常渲染：status=rendered、首行非空、字数与真源一致（正文不复制进注册表）", () => {
    const entries = listWorkflowTemplateRegistry()
    const volume = entryOf(entries, "volume-outline")
    expect(volume.templateStatus).toBe("rendered")
    expect(volume.templateHead).toBe("# 卷纲_第1卷-«title».md")
    expect(volume.templateLength).toBe(getVolumeOutlineTemplate(1, "«title»", "«chapterRange»").length)
    expect(volume.error).toBeNull()
    expect(Object.keys(volume)).not.toContain("text")
    expect(volume.templateLength).toBeGreaterThan(volume.templateHead?.length ?? 0)
  })

  it("渲染抛错 → failed + error 文案 + head 为 null（绝不写空串冒充成功）", () => {
    const entries = listWorkflowTemplateRegistry({
      volumeOutline: () => {
        throw new Error("boom-volume")
      },
    })
    const volume = entryOf(entries, "volume-outline")
    expect(volume.templateStatus).toBe("failed")
    expect(volume.templateHead).toBeNull()
    expect(volume.templateLength).toBe(0)
    expect(volume.error).toBeTruthy()
    expect(volume.error).toContain("boom-volume")
    expect(volume.error).not.toBe("")
    // 登记项本身（必填字段/源）不因渲染失败而消失。
    expect(volume.requiredFieldCount).toBe(6)
    expect(volume.source).toContain("outline-templates.ts")
  })

  it("渲染结果非字符串 / 空串 → 同样 failed（不静默当成功）", () => {
    const nonString = entryOf(listWorkflowTemplateRegistry({ chapterOutline: () => 42 }), "chapter-outline")
    expect(nonString.templateStatus).toBe("failed")
    expect(nonString.templateHead).toBeNull()
    expect(nonString.error).toBeTruthy()

    const empty = entryOf(listWorkflowTemplateRegistry({ chapterOutline: () => "   \n" }), "chapter-outline")
    expect(empty.templateStatus).toBe("failed")
    expect(empty.error).toBeTruthy()
    expect(empty.missingRequiredFieldNames).toBeNull()
  })

  it("真源无渲染函数的条目 → not-applicable（不是 failed，error 为 null）", () => {
    const entries = listWorkflowTemplateRegistry()
    for (const id of ["chapter-blueprint", "chapter-hook-types", "chapter-position-types"]) {
      const entry = entryOf(entries, id)
      expect(entry.templateStatus).toBe("not-applicable")
      expect(entry.templateHead).toBeNull()
      expect(entry.error).toBeNull()
      expect(entry.missingRequiredFieldNames).toBeNull()
    }
  })

  it("skill-stage 清单与 novel-skill-hooks 的 stage 声明一致（5 条，码点序）", () => {
    const entries = listWorkflowTemplateRegistry()
    const stages = entries.filter((entry) => entry.kind === "skill-stage")
    expect(stages.map((entry) => entry.id)).toEqual(
      NOVEL_SKILL_STAGES.map((stage) => `skill-stage-${stage.split("_").join("-")}`),
    )
    expect(NOVEL_SKILL_STAGES).toEqual([
      "post_draft_light_check",
      "post_gate_literary_polish",
      "pre_outline_soft_gate",
      "pre_six_dim_review",
      "pre_write_prompt",
    ])
    for (const stage of stages) {
      expect(stage.source).toBe("novel-skill-hooks.ts:NovelSkillStage")
      expect(stage.requiredFields).toEqual([])
      expect(stage.enums).toEqual([])
      expect(stage.templateStatus).toBe("not-applicable")
    }
  })

  it("每条登记项都有 源文件:符号名，且 error 非 null 当且仅当 failed", () => {
    const entries = listWorkflowTemplateRegistry()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.source).toMatch(/^[a-z-]+\.ts:[A-Za-z_,]+$/)
      expect(entry.error !== null).toBe(entry.templateStatus === "failed")
    }
  })

  it("确定性：两次调用深度相等（纯函数、零 IO）", () => {
    expect(listWorkflowTemplateRegistry()).toEqual(listWorkflowTemplateRegistry())
  })
})

describe("groupWorkflowTemplates", () => {
  it("组间与组内均按码点排序，且覆盖全部条目（不丢不重）", () => {
    const entries = listWorkflowTemplateRegistry()
    const groups = groupWorkflowTemplates(entries)

    const kinds = groups.map((group) => group.kind)
    expect(kinds).toEqual([...kinds].sort(byCodePoint))
    expect(kinds).toEqual(["chapter", "enum", "skill-stage", "volume"])

    for (const group of groups) {
      const ids = group.entries.map((entry) => entry.id)
      expect(ids).toEqual([...ids].sort(byCodePoint))
      for (const entry of group.entries) expect(entry.kind).toBe(group.kind)
    }

    const flat = groups.flatMap((group) => group.entries.map((entry) => entry.id)).sort(byCodePoint)
    expect(flat).toEqual(entries.map((entry) => entry.id).sort(byCodePoint))
    expect(new Set(flat).size).toBe(flat.length)

    const ids = entries.map((entry) => entry.id)
    expect(ids).toEqual([...ids].sort(byCodePoint))
  })

  it("空输入 → 空分组（不造占位组）", () => {
    expect(groupWorkflowTemplates([])).toEqual([])
  })
})

describe("hasFieldLine：标题行整词匹配（审查回归）", () => {
  it("子串不算命中：「爽点节奏表」不满足「爽点节奏」", () => {
    expect(hasFieldLine("## 爽点节奏表", "爽点节奏")).toBe(false)
    expect(hasFieldLine("## 本卷关键反转", "关键反转")).toBe(false)
  })

  it("行首整词 / 字段名后紧跟分隔符算命中", () => {
    expect(hasFieldLine("- 爽点节奏", "爽点节奏")).toBe(true)
    expect(hasFieldLine("1. 关键反转：主角身份揭晓", "关键反转")).toBe(true)
    expect(hasFieldLine("伏笔布局（本卷三条）", "伏笔布局")).toBe(true)
    expect(hasFieldLine("本卷关键反转", "关键反转")).toBe(false)
  })
})

describe("hasFieldLine：常见排版不漏报（审查回归 2）", () => {
  it("加粗 / 中文序数 / 表格单元格都算命中", () => {
    expect(hasFieldLine("**爽点节奏**", "爽点节奏")).toBe(true)
    expect(hasFieldLine("## 一、爽点节奏", "爽点节奏")).toBe(true)
    expect(hasFieldLine("| 关键反转 | 说明 |", "关键反转")).toBe(true)
    expect(hasFieldLine("第二章 伏笔布局", "伏笔布局")).toBe(true)
  })

  it("仍不把更长标签算命中（不漏也误不出）", () => {
    expect(hasFieldLine("## 爽点节奏表", "爽点节奏")).toBe(false)
    expect(hasFieldLine("| 本卷关键反转 | x |", "关键反转")).toBe(false)
    // 纯空格后接后文不是声明该字段（审查点 3）
    expect(hasFieldLine("| 爽点节奏 补充 |", "爽点节奏")).toBe(false)
  })

  it("加粗包裹 + 冒号说明算命中（审查点 3）", () => {
    expect(hasFieldLine("**爽点节奏**：说明", "爽点节奏")).toBe(true)
    expect(hasFieldLine("| **关键反转** | 说明 |", "关键反转")).toBe(true)
  })
})
