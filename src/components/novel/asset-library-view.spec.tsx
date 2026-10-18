// @vitest-environment jsdom
/**
 * asset-library-view.spec.tsx — 资产库可视化契约。
 *
 * 覆盖（改进计划 B 项验收）：
 *   1. 注入快照 → 5 行渲染 + 已生成/违规汇总；
 *   2. 未生成的库显式「未生成」（诚实空态，不造条目）；
 *   3. 守恒失配 → 红色告警行；违规清单逐条渲染；
 *   4. 读取失败（error）→ 显示原因，不渲染为 0 条的「正常」；
 *   5. projectPath 为空 → 5 行全部未生成（不崩）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AssetLibraryView } from "./asset-library-view"
import { LIBRARY_IDS, type AssetLibrarySnapshot } from "@/lib/novel"

function snap(overrides: Partial<AssetLibrarySnapshot> & { libraryId: AssetLibrarySnapshot["libraryId"] }): AssetLibrarySnapshot {
  return {
    present: false,
    entryCount: 0,
    contentHash: null,
    schemaVersion: null,
    conserved: false,
    health: null,
    ...overrides,
  }
}

afterEach(() => cleanup())

describe("AssetLibraryView", () => {
  it("注入快照：全部库行齐全（含 Wave 3B 关系库）+ 汇总已生成/违规数", () => {
    render(
      <AssetLibraryView
        projectPath="/p"
        snapshots={[
          snap({
            libraryId: "genre_base",
            present: true,
            entryCount: 3,
            conserved: true,
            health: { libraryId: "genre_base", healthy: true, violations: [], entryCount: 3 },
          }),
          snap({
            libraryId: "world_sample",
            present: true,
            entryCount: 2,
            conserved: true,
            health: { libraryId: "world_sample", healthy: false, violations: ["world_sample \"w1\" 缺 transferableConstraints"], entryCount: 2 },
          }),
          ...LIBRARY_IDS.filter((id) => id !== "genre_base" && id !== "world_sample").map((id) => snap({ libraryId: id })),
        ]}
      />,
    )
    expect(screen.getByTestId("asset-library-view")).toBeTruthy()
    for (const id of LIBRARY_IDS) expect(screen.getByTestId(`asset-library-row-${id}`)).toBeTruthy()
    expect(screen.getByTestId("asset-library-summary").textContent).toContain(`已生成 2/${LIBRARY_IDS.length}`)
    expect(screen.getByTestId("asset-library-summary").textContent).toContain("违规 1")
    expect(screen.getByTestId("asset-library-count-genre_base").textContent).toContain("3 条")
  })

  it("未生成的库显示「未生成」而非 0 条正常", () => {
    render(<AssetLibraryView projectPath="/p" snapshots={[snap({ libraryId: "title_seed" })]} />)
    expect(screen.getByTestId("asset-library-empty-title_seed").textContent).toContain("未生成")
    expect(screen.queryByTestId("asset-library-count-title_seed")).toBeNull()
  })

  it("守恒失配 → 红色告警 + 违规清单逐条渲染", () => {
    render(
      <AssetLibraryView
        projectPath="/p"
        snapshots={[
          snap({
            libraryId: "pacing_pattern",
            present: true,
            entryCount: 1,
            conserved: false,
            health: { libraryId: "pacing_pattern", healthy: false, violations: ["守恒失配（疑似手工篡改）: x != y"], entryCount: 1 },
          }),
        ]}
      />,
    )
    expect(screen.getByTestId("asset-library-drift-pacing_pattern").textContent).toContain("守恒失配")
    expect(screen.getByTestId("asset-library-violations-pacing_pattern").textContent).toContain("疑似手工篡改")
  })

  it("读取失败 → 显示 error 原因（不伪装成空库）", () => {
    render(
      <AssetLibraryView
        projectPath="/p"
        snapshots={[snap({ libraryId: "character_archetype", error: "JSON 解析失败：bad token" })]}
      />,
    )
    expect(screen.getByTestId("asset-library-error-character_archetype").textContent).toContain("JSON 解析失败")
  })

  it("projectPath 为空 → 5 行全未生成（不崩、不造数）", () => {
    render(<AssetLibraryView projectPath="" />)
    for (const id of LIBRARY_IDS) expect(screen.getByTestId(`asset-library-empty-${id}`)).toBeTruthy()
  })
})

describe("关系库迁移入口（Wave 3B 生产接线）", () => {
  afterEach(() => cleanup())

  it("点击迁移：显示迁移状态与边数（conflict 明确标注未覆盖）", async () => {
    const migrate = vi.fn(async () => ({ status: "conflict" as const, entryCount: 3 }))
    render(<AssetLibraryView projectPath="/p" snapshots={[snap({ libraryId: "genre_base" })]} migrateRelationships={migrate} />)
    fireEvent.click(screen.getByTestId("asset-library-migrate-relationships"))
    await waitFor(() => expect(screen.getByTestId("asset-library-migrate-status")).toBeTruthy())
    expect(migrate).toHaveBeenCalledWith("/p")
    expect(screen.getByTestId("asset-library-migrate-status").textContent).toContain("conflict")
    expect(screen.getByTestId("asset-library-migrate-status").textContent).toContain("未覆盖")
  })

  it("迁移抛错：不显示假成功状态", async () => {
    const migrate = vi.fn(async () => {
      throw new Error("boom")
    })
    render(<AssetLibraryView projectPath="/p" snapshots={[snap({ libraryId: "genre_base" })]} migrateRelationships={migrate} />)
    fireEvent.click(screen.getByTestId("asset-library-migrate-relationships"))
    await waitFor(() => expect(migrate).toHaveBeenCalled())
    expect(screen.queryByTestId("asset-library-migrate-status")).toBeNull()
  })
})
