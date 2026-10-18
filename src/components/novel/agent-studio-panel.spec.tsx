// @vitest-environment jsdom
/**
 * agent-studio-panel.spec.tsx — 代理工作室只读面板契约。
 *
 * 覆盖：
 *   1. 根 testid + 汇总计数；
 *   2. 每行 `agent-studio-row-<id>`；
 *   3. 重复真源**显式**渲染（`agent-studio-duplicate-<id>`）且副本逐条列出、不截断；
 *   4. ok 行不得出现重复标记（防「一律渲染」的假阳性）；
 *   5. 缺失真源行显示缺失语义 + `missingSources` 汇总；
 *   6. 不适用项 `agent-studio-na-<id>` 渲染原因；
 *   7. 空投影诚实空态；
 *   8. 只读性：不渲染任何可交互控件（input/button/select/textarea）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import {
  AgentStudioPanel,
  type AgentStudioPanelProjection,
  type AgentStudioPanelRow,
} from "./agent-studio-panel"

afterEach(() => cleanup())

function row(overrides: Partial<AgentStudioPanelRow> & { id: string }): AgentStudioPanelRow {
  return {
    label: `标签-${overrides.id}`,
    sourceFile: `src/example/${overrides.id}.ts:1`,
    hasDefault: true,
    duplicatedIn: [],
    status: "ok",
    ...overrides,
  }
}

function projectionOf(rows: readonly AgentStudioPanelRow[]): AgentStudioPanelProjection {
  const defaultsById: Record<string, string> = {}
  for (const r of rows) {
    if (r.hasDefault) defaultsById[r.id] = `默认-${r.id}`
  }
  return {
    rows,
    missingSources: rows.filter((r) => r.status === "missing").map((r) => r.sourceFile.split(":")[0]),
    duplicateRowIds: rows.filter((r) => r.duplicatedIn.length > 0).map((r) => r.id),
    notApplicable: [
      { id: "llm.apiMode.nonCustom", label: "apiMode（非 custom）", reason: "只在 custom 提供方下参与路由。" },
    ],
    defaultsById,
    totals: {
      total: rows.length,
      ok: rows.filter((r) => r.status === "ok").length,
      duplicated: rows.filter((r) => r.status === "duplicated").length,
      missing: rows.filter((r) => r.status === "missing").length,
    },
  }
}

describe("AgentStudioPanel", () => {
  it("渲染根 testid 与四类计数汇总", () => {
    render(
      <AgentStudioPanel
        projection={projectionOf([
          row({ id: "llm.model" }),
          row({ id: "novel.reviewModel", status: "duplicated", duplicatedIn: ["src/a.ts:1"] }),
          row({ id: "agent.maxRounds", status: "missing", sourceFile: "src/gone.ts:9" }),
        ])}
      />,
    )

    expect(screen.getByTestId("agent-studio-panel")).toBeTruthy()
    expect(screen.getByText(/共 3 项/)).toBeTruthy()
    expect(screen.getByText(/一致 1/)).toBeTruthy()
    expect(screen.getByText(/重复真源 1/)).toBeTruthy()
    expect(screen.getByText(/缺失\s*1/)).toBeTruthy()
  })

  it("每一行都渲染 agent-studio-row-<id>", () => {
    render(
      <AgentStudioPanel
        projection={projectionOf([row({ id: "llm.model" }), row({ id: "store.aiChatModel" })])}
      />,
    )

    expect(screen.getByTestId("agent-studio-row-llm.model")).toBeTruthy()
    expect(screen.getByTestId("agent-studio-row-store.aiChatModel")).toBeTruthy()
  })

  it("重复真源显式标出：标记存在 + 全部副本逐条渲染（不截断）", () => {
    const duplicatedIn = [
      "src/lib/env-llm-defaults.ts:39",
      "src/lib/llm-config/llm-presets.ts:60",
      "src/lib/llm-config/preset-resolver.ts:74",
    ]
    render(
      <AgentStudioPanel
        projection={projectionOf([
          row({ id: "llm.apiMode", status: "duplicated", duplicatedIn, sourceFile: "src/stores/wiki-store.ts:128" }),
        ])}
      />,
    )

    const marker = screen.getByTestId("agent-studio-duplicate-llm.apiMode")
    expect(marker).toBeTruthy()
    expect(marker.textContent).toContain("3 处")
    for (const ref of duplicatedIn) {
      expect(marker.textContent).toContain(ref)
    }
  })

  it("无副本的 ok 行不得渲染重复标记", () => {
    render(<AgentStudioPanel projection={projectionOf([row({ id: "llm.model" })])} />)

    expect(screen.queryByTestId("agent-studio-duplicate-llm.model")).toBeNull()
  })

  it("缺失真源：行内给出缺失语义，且 missingSources 汇总列出路径", () => {
    render(
      <AgentStudioPanel
        projection={projectionOf([
          row({
            id: "modelRoutes.view",
            label: "模型路由视图",
            sourceFile: "src/components/novel/model-routes-view.tsx",
            hasDefault: false,
            status: "missing",
            duplicatedIn: ["src/components/layout/planned-views.ts:36"],
          }),
        ])}
      />,
    )

    const missingRow = screen.getByTestId("agent-studio-row-modelRoutes.view")
    expect(missingRow.textContent).toContain("缺失")
    expect(missingRow.textContent).toContain("真源文件不存在")
    // 缺失 ≠ 可隐藏副本：缺失行仍必须暴露重复声明。
    expect(screen.getByTestId("agent-studio-duplicate-modelRoutes.view")).toBeTruthy()

    const summary = screen.getByTestId("agent-studio-missing-sources")
    expect(summary.textContent).toContain("src/components/novel/model-routes-view.tsx")
  })

  it("无不适用项之外的 N/A 渲染 agent-studio-na-<id> 并给出原因", () => {
    render(<AgentStudioPanel projection={projectionOf([row({ id: "llm.model" })])} />)

    const na = screen.getByTestId("agent-studio-na-llm.apiMode.nonCustom")
    expect(na.textContent).toContain("apiMode（非 custom）")
    expect(na.textContent).toContain("只在 custom 提供方下参与路由。")
  })

  it("空投影：诚实空态 + 无缺失真源，不伪造行", () => {
    render(<AgentStudioPanel projection={projectionOf([])} />)

    expect(screen.getByTestId("agent-studio-empty")).toBeTruthy()
    expect(screen.queryByTestId(/^agent-studio-row-/)).toBeNull()
    expect(screen.getByTestId("agent-studio-missing-sources").textContent).toContain("无缺失真源")
  })

  it("只读面板：不渲染任何可交互控件", () => {
    const { container } = render(
      <AgentStudioPanel
        projection={projectionOf([
          row({ id: "llm.model" }),
          row({ id: "novel.reviewModel", status: "duplicated", duplicatedIn: ["src/a.ts:1"] }),
          row({ id: "agent.maxRounds", status: "missing", sourceFile: "src/gone.ts:9" }),
        ])}
      />,
    )

    expect(container.querySelectorAll("input, button, select, textarea")).toHaveLength(0)
  })

  it("默认值存在时展示字面量，无默认值时明示不伪造", () => {
    render(
      <AgentStudioPanel
        projection={projectionOf([
          row({ id: "llm.maxContextSize" }),
          row({ id: "judge.judgePool", hasDefault: false }),
        ])}
      />,
    )

    expect(screen.getByTestId("agent-studio-row-llm.maxContextSize").textContent).toContain("默认-llm.maxContextSize")
    expect(screen.getByTestId("agent-studio-row-judge.judgePool").textContent).toContain("无默认值")
  })
})

describe("静态声明模式（审查回归）：不假装探测过磁盘", () => {
  afterEach(cleanup)

  it("staticDeclarationOnly → 范围说明 + 计数与缺失汇总都是 N/A 口径", () => {
    render(
      <AgentStudioPanel
        staticDeclarationOnly
        projection={{
          rows: [
            {
              id: "llm.apiMode",
              label: "模型接入方式",
              sourceFile: "src/stores/wiki-store.ts:112",
              hasDefault: true,
              duplicatedIn: [],
              status: "ok",
            },
            {
              id: "llm.apiKey",
              label: "密钥来源",
              sourceFile: "src/stores/wiki-store.ts:128",
              hasDefault: true,
              duplicatedIn: ["src/lib/novel/config.ts:9"],
              status: "duplicated",
            },
            {
              id: "llm.model",
              label: "默认模型",
              sourceFile: "src/lib/novel/model-resolver.ts:159",
              hasDefault: false,
              duplicatedIn: [],
              status: "missing",
            },
          ],
          missingSources: [],
          duplicateRowIds: [],
          notApplicable: [],
          defaultsById: { "llm.apiMode": "responses" },
          totals: { total: 3, ok: 1, duplicated: 1, missing: 1 },
        }}
      />,
    )
    expect(screen.getByTestId("agent-studio-static-scope").textContent).toContain("未")
    // 静态模式：行徽章不许写「一致」（那是在声称探测过磁盘）
    // 每一行都必须写「已登记」，不能只看第一个徽章（弱断言修正）
    const badges = Array.from(document.querySelectorAll("[data-badge]")).map((el) =>
      el.getAttribute("data-badge"),
    )
    // 三种状态各自的静态口径都要锁住（ok 不许写「一致」，missing 必须标「未探测」）
    expect(badges).toEqual(["已登记", "重复声明", "缺失（未探测）"])
    expect(badges).not.toContain("一致")
    expect(screen.getByTestId("agent-studio-panel").textContent).not.toMatch(/缺失真源一律显式列出/)
    const totals = screen.getByTestId("agent-studio-totals").textContent ?? ""
    expect(totals).toContain("缺失判定 N/A")
    expect(totals).not.toMatch(/缺失 0/)
    const missing = screen.getByTestId("agent-studio-missing-sources").textContent ?? ""
    expect(missing).toContain("N/A")
    expect(missing).not.toContain("无缺失真源")
  })
})
