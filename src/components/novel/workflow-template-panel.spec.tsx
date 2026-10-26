// @vitest-environment jsdom
/**
 * 工作流/大纲模板面板：只读登记渲染 + 注入跟随 + 显式 N/A（**删掉 N/A 即红**）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { WorkflowTemplatePanel } from "./workflow-template-panel"
import type { WorkflowTemplateEntry, WorkflowTemplateGroup } from "@/lib/novel"

function makeEntry(
  id: string,
  overrides: Partial<WorkflowTemplateEntry> = {},
): WorkflowTemplateEntry {
  return {
    id,
    kind: "volume",
    title: `假模板 ${id}`,
    requiredFields: [],
    requiredFieldCount: 0,
    enums: [],
    enumListCount: 0,
    enumValueCount: 0,
    source: "fake-source.ts:FAKE_SYMBOL",
    templateStatus: "not-applicable",
    templateHead: null,
    templateLength: 0,
    missingRequiredFieldNames: null,
    error: null,
    ...overrides,
  }
}

/** 注入的分组**故意不按码点序**（volume 在前、chapter 在后）：面板必须原样跟随注入。 */
const fakeGroups: readonly WorkflowTemplateGroup[] = [
  {
    kind: "volume",
    entries: [
      makeEntry("fake-volume", {
        kind: "volume",
        requiredFields: ["甲字段", "乙字段"],
        requiredFieldCount: 2,
        enums: [
          {
            name: "FAKE_ENUM",
            linkedField: "甲字段",
            valueCount: 2,
            values: ["取值一", "取值二"],
            source: "fake-source.ts:FAKE_ENUM",
          },
        ],
        enumListCount: 1,
        enumValueCount: 2,
        source: "fake-source.ts:FAKE_SYMBOL",
        templateStatus: "rendered",
        templateHead: "「假首行」",
        templateLength: 123,
        missingRequiredFieldNames: ["丙字段"],
      }),
    ],
  },
  {
    kind: "chapter",
    entries: [
      makeEntry("fake-chapter"),
      makeEntry("fake-broken", {
        kind: "chapter",
        title: "假模板（渲染必失败）",
        requiredFields: ["丁字段"],
        requiredFieldCount: 1,
        templateStatus: "failed",
        error: "boom",
      }),
    ],
  },
]

describe("WorkflowTemplatePanel", () => {
  afterEach(cleanup)

  it("注入假数据：组顺序/计数/条目内容/源/缺失字段全部跟随注入（不在面板里再排序）", () => {
    const { container } = render(<WorkflowTemplatePanel groups={fakeGroups} />)
    expect(screen.getByTestId("workflow-template-panel").textContent).toContain("3 条")
    expect(screen.getByTestId("workflow-template-panel").textContent).toContain("2 组")

    const groupIds = [...container.querySelectorAll("[data-testid^='workflow-template-group-']")].map(
      (el) => el.getAttribute("data-testid"),
    )
    expect(groupIds).toEqual(["workflow-template-group-volume", "workflow-template-group-chapter"])

    const volumeText = screen.getByTestId("workflow-template-fake-volume").textContent ?? ""
    expect(volumeText).toContain("必填字段 2 项：")
    expect(screen.getByTestId("workflow-template-fake-volume-required-fields").textContent).toContain("甲字段")
    expect(screen.getByTestId("workflow-template-fake-volume-required-fields").textContent).toContain("乙字段")
    expect(volumeText).toContain("可选枚举 1 类 / 2 值")
    expect(volumeText).toContain("FAKE_ENUM（甲字段 · 2 值）")
    expect(volumeText).toContain("模板首行：「假首行」 · 全文 123 字")
    expect(volumeText).toContain("源：fake-source.ts:FAKE_SYMBOL")
    expect(screen.getByTestId("workflow-template-fake-volume-missing").textContent).toContain(
      "丙字段",
    )
  })

  it("渲染失败条目：显示 error 文案，且不显示「模板首行」（不写空串冒充成功）", () => {
    render(<WorkflowTemplatePanel groups={fakeGroups} />)
    const broken = screen.getByTestId("workflow-template-fake-broken")
    expect(screen.getByTestId("workflow-template-fake-broken-error").textContent).toBe("boom")
    expect(broken.textContent).toContain("模板渲染失败")
    expect(broken.textContent).not.toContain("模板首行")
  })

  it("缺真源的项写显式 N/A（条目级 + 面板级；删掉即 getByTestId 抛错）", () => {
    render(<WorkflowTemplatePanel groups={fakeGroups} />)
    // 条目级：fake-chapter 无必填字段 / 无枚举 / 无渲染函数 → 三行 N/A。
    for (const suffix of ["required-fields", "enums", "template"]) {
      const na = screen.getByTestId(`workflow-template-na-fake-chapter-${suffix}`)
      expect(na.textContent).toContain("N/A")
    }
    // 面板级：三条无真源的能力显式 N/A。
    expect(screen.getByTestId("workflow-template-na-usage").textContent).toContain("N/A")
    expect(screen.getByTestId("workflow-template-na-version").textContent).toContain("N/A")
    expect(screen.getByTestId("workflow-template-na-stage-order").textContent).toContain("N/A")
  })

  it("注入空分组 → 0 条 0 组（不造占位行）", () => {
    render(<WorkflowTemplatePanel groups={[]} />)
    expect(screen.getByTestId("workflow-template-panel").textContent).toContain("0 条 · 0 组")
  })

  it("默认（不注入）：真的枚举真源注册表 —— 组、条目、必填字段计数、枚举取值都在", () => {
    render(<WorkflowTemplatePanel />)
    expect(screen.getByTestId("workflow-template-group-volume")).toBeTruthy()
    expect(screen.getByTestId("workflow-template-group-chapter")).toBeTruthy()
    expect(screen.getByTestId("workflow-template-group-enum")).toBeTruthy()
    expect(screen.getByTestId("workflow-template-group-skill-stage")).toBeTruthy()

    expect(
      screen.getByTestId("workflow-template-volume-outline-required-fields").textContent,
    ).toContain("必填字段 6 项")
    expect(
      screen.getByTestId("workflow-template-chapter-outline-required-fields").textContent,
    ).toContain("必填字段 15 项")

    // 枚举清单条目直接列出真源取值。
    expect(
      screen.getByTestId("workflow-template-chapter-position-types-values-CHAPTER_POSITION_TYPES")
        .textContent,
    ).toContain("收束")

    // 真源自证：卷纲模板缺「伏笔布局」→ 面板如实提示。
    expect(screen.getByTestId("workflow-template-volume-outline-missing").textContent).toContain(
      "伏笔布局",
    )

    // 真源没有渲染函数的条目（skill stage）→ 三条 N/A 都在。
    for (const suffix of ["required-fields", "enums", "template"]) {
      expect(
        screen.getByTestId(`workflow-template-na-skill-stage-pre-write-prompt-${suffix}`).textContent,
      ).toContain("N/A")
    }
  })
})
