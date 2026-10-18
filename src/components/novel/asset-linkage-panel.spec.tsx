// @vitest-environment jsdom
/** 资产联动面板：冲突清单、N/A 说明、产物缺失显示 N/A 而非 0。 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { AssetLinkagePanel } from "./asset-linkage-panel"

afterEach(cleanup)

const baseInput = { characters: [], relationshipArtifact: null, snapshotRelationLines: [] }

describe("无冲突", () => {
  it("干净态渲染，但仍提示缺失面不算一致", () => {
    render(<AssetLinkagePanel input={baseInput} />)
    expect(screen.getByTestId("asset-linkage-clean")).toBeTruthy()
    expect(screen.getByTestId("asset-linkage-clean").textContent).toContain("不要当成")
    expect(screen.queryByTestId("asset-linkage-conflicts")).toBeNull()
  })

  it("角色状态未装载 → 摘要写 N/A（未装载），且不给绿态", () => {
    render(<AssetLinkagePanel input={{ ...baseInput, charactersLoaded: false }} />)
    const summary = screen.getByTestId("asset-linkage-summary").textContent ?? ""
    expect(summary).toContain("N/A（未装载）")
    expect(summary).not.toMatch(/关系边：\s*0/)
    expect(screen.queryByTestId("asset-linkage-clean")).toBeNull()
    expect(screen.getByTestId("asset-linkage-unloaded")).toBeTruthy()
  })

  it("产物缺失 → 摘要显示 N/A（未迁移），不显示 0 条", () => {
    render(<AssetLinkagePanel input={baseInput} />)
    const summary = screen.getByTestId("asset-linkage-summary").textContent ?? ""
    expect(summary).toContain("N/A（未迁移）")
    expect(summary).not.toMatch(/已存产物：\s*0 条/)
  })
})

describe("有冲突", () => {
  it("冲突逐条渲染，码与证据都在", () => {
    render(
      <AssetLinkagePanel
        input={{
          characters: [
            {
              characterName: "甲",
              relationships: {},
            },
          ],
          relationshipArtifact: null,
          snapshotRelationLines: [{ chapterNumber: 5, text: "甲与乙结盟" }],
        }}
      />,
    )
    expect(screen.getByTestId("asset-linkage-conflicts")).toBeTruthy()
    expect(
      screen.getByTestId("asset-linkage-conflict-snapshot_relation_not_in_state-0").textContent,
    ).toContain("甲与乙结盟")
  })

  it("注入 result 优先于 input", () => {
    render(
      <AssetLinkagePanel
        input={baseInput}
        result={{
          conflicts: [
            { code: "graph_edge_missing", left: "甲", right: "乙", detail: "图谱缺边" },
          ],
          na: ["图谱边：已提供"],
          derivedEdgeCount: 3,
          artifactEdgeCount: 2,
        }}
      />,
    )
    expect(screen.getByTestId("asset-linkage-conflict-graph_edge_missing-0")).toBeTruthy()
    expect(screen.getByTestId("asset-linkage-summary").textContent).toContain("3")
  })
})

describe("诚实口径", () => {
  it("范围说明写明只比对不改写、语义 unknown", () => {
    render(<AssetLinkagePanel input={baseInput} />)
    const scope = screen.getByTestId("asset-linkage-scope").textContent ?? ""
    expect(scope).toContain("只比对")
    expect(scope).toContain("unknown")
  })

  it("N/A 段落有内容（不是空列表）", () => {
    render(<AssetLinkagePanel input={baseInput} />)
    expect(screen.getByTestId("asset-linkage-na").textContent).toContain("N/A")
  })
})
