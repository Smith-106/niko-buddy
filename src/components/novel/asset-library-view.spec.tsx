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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AssetLibraryView } from "./asset-library-view"
import { LIBRARY_IDS, type AssetLibrarySnapshot } from "@/lib/novel"

// 覆盖补齐：磁盘装载分支经 barrel 注入（默认空实现；快照注入用例不受影响——
// 它们走 snapshots !== undefined 早退，根本不调 barrel）。
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadAllAssetLibrarySnapshots: vi.fn(async () => []),
    loadCharacterStates: vi.fn(async () => null),
    loadNovelSessionStatus: vi.fn(async () => null),
    listBindableNovelCharacters: vi.fn(async () => []),
    // 生产关系库迁移（未注入 migrateRelationships 时的默认落点）：既有用例都显式注入，
    // 这里的 mock 只服务「默认接线」用例，绝不触盘。
    migrateRelationshipLibrary: vi.fn(async () => ({
      status: "empty" as const,
      path: "",
      entryCount: 0,
      existingHash: null,
      derivedHash: "h",
    })),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(async () => "") }
})

import {
  listBindableNovelCharacters,
  loadAllAssetLibrarySnapshots,
  loadCharacterStates,
  loadNovelSessionStatus,
  migrateRelationshipLibrary,
} from "@/lib/novel"
import { readFile } from "@/commands/fs"

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

describe("AssetLibraryView 磁盘装载分支（覆盖补齐）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadAllAssetLibrarySnapshots).mockResolvedValue([])
    vi.mocked(loadCharacterStates).mockResolvedValue({ characters: [], lastUpdated: "" })
    vi.mocked(loadNovelSessionStatus).mockResolvedValue(null)
    vi.mocked(listBindableNovelCharacters).mockResolvedValue([])
    vi.mocked(readFile).mockResolvedValue("")
  })

  afterEach(() => cleanup())

  it("无快照注入 → 经 barrel 装盘：rows 渲染 + 汇总 + 角色/提取联动装载", async () => {
    vi.mocked(loadAllAssetLibrarySnapshots).mockResolvedValue([
      snap({
        libraryId: "genre_base",
        present: true,
        entryCount: 3,
        conserved: true,
        health: { libraryId: "genre_base", healthy: true, violations: [], entryCount: 3 },
      }),
      ...LIBRARY_IDS.filter((id) => id !== "genre_base").map((id) => snap({ libraryId: id })),
    ])
    vi.mocked(loadCharacterStates).mockResolvedValue({ characters: [{ id: "c1" }] } as never)
    vi.mocked(loadNovelSessionStatus).mockResolvedValue({ current_task: { chapter_number: 3 } } as never)
    vi.mocked(readFile).mockResolvedValue("第三章正文……")
    vi.mocked(listBindableNovelCharacters).mockResolvedValue(["林晚"])
    render(<AssetLibraryView projectPath="/p/book" />)
    // 装载中骨架 → 装盘后行齐全
    expect(screen.getByTestId("asset-library-loading")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("asset-library-count-genre_base")).toBeTruthy())
    expect(screen.getByTestId("asset-library-summary").textContent).toContain(`已生成 1/${LIBRARY_IDS.length}`)
    expect(loadAllAssetLibrarySnapshots).toHaveBeenCalledWith("/p/book", undefined)
    // 当前章正文经 chapterDraftPath 读取（提取联动分支）
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining("chapters/3/draft.md"))
  })

  it("装盘失败 → 诚实空态（各库未生成，不臆造条目）", async () => {
    vi.mocked(loadAllAssetLibrarySnapshots).mockRejectedValue(new Error("disk gone"))
    render(<AssetLibraryView projectPath="/p/book" />)
    await waitFor(() => expect(screen.getByTestId("asset-library-row-genre_base")).toBeTruthy())
    for (const id of LIBRARY_IDS) expect(screen.getByTestId(`asset-library-empty-${id}`)).toBeTruthy()
    expect(screen.getByTestId("asset-library-summary").textContent).toContain("已生成 0/")
  })

  it("卸载中断装盘 → 陈旧响应被丢弃（cancelled 守卫）", async () => {
    let resolve!: (v: never[]) => void
    vi.mocked(loadAllAssetLibrarySnapshots).mockImplementationOnce(
      () => new Promise((res) => { resolve = res as (v: never[]) => void }),
    )
    const { unmount } = render(<AssetLibraryView projectPath="/p/book" />)
    unmount()
    resolve([])
    await new Promise((r) => setTimeout(r, 20))
    // 卸载后无崩、无状态更新（守卫早退）
    expect(screen.queryByTestId("asset-library-view")).toBeNull()
  })

  it("迁移成功 written → 自动重装（行内从未生成翻为已生成）", async () => {
    const first = LIBRARY_IDS.map((id) => snap({ libraryId: id }))
    const second = [
      snap({
        libraryId: "relationship_edge",
        present: true,
        entryCount: 2,
        conserved: true,
        health: { libraryId: "relationship_edge", healthy: true, violations: [], entryCount: 2 },
      }),
      ...LIBRARY_IDS.filter((id) => id !== "relationship_edge").map((id) => snap({ libraryId: id })),
    ]
    vi.mocked(loadAllAssetLibrarySnapshots).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    render(
      <AssetLibraryView
        projectPath="/p/book"
        migrateRelationships={async () => ({ status: "written" as const, entryCount: 2 })}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("asset-library-row-genre_base")).toBeTruthy())
    fireEvent.click(screen.getByTestId("asset-library-migrate-relationships"))
    await waitFor(() => expect(screen.getByTestId("asset-library-migrate-status")).toBeTruthy())
    expect(screen.getByTestId("asset-library-migrate-status").textContent).toContain("已写入")
    await waitFor(() => expect(screen.getByTestId("asset-library-count-relationship_edge")).toBeTruthy())
    expect(loadAllAssetLibrarySnapshots).toHaveBeenCalledTimes(2)
  })
})

describe("AssetLibraryView 读失败兜底（覆盖补齐 2）", () => {
  it("角色/正文读取失败 → null/空串兜底（不崩不断链）", async () => {
    vi.mocked(loadAllAssetLibrarySnapshots).mockResolvedValue(
      LIBRARY_IDS.map((id) => snap({ libraryId: id })),
    )
    vi.mocked(loadCharacterStates).mockRejectedValueOnce(new Error("characters gone"))
    vi.mocked(loadNovelSessionStatus).mockResolvedValue({ current_task: { chapter_number: 3 } } as never)
    vi.mocked(readFile).mockRejectedValueOnce(new Error("draft gone"))
    vi.mocked(listBindableNovelCharacters).mockResolvedValue([])
    render(<AssetLibraryView projectPath="/p/book" />)
    await waitFor(() => expect(screen.getByTestId("asset-library-row-genre_base")).toBeTruthy())
    expect(screen.getByTestId("asset-library-summary").textContent).toContain(`已生成 0/${LIBRARY_IDS.length}`)
  })
})

describe("AssetLibraryView 联动装载失败兜底（覆盖补齐 3）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadAllAssetLibrarySnapshots).mockResolvedValue(LIBRARY_IDS.map((id) => snap({ libraryId: id })))
    vi.mocked(loadCharacterStates).mockResolvedValue({ characters: [], lastUpdated: "" })
    vi.mocked(loadNovelSessionStatus).mockResolvedValue(null)
    vi.mocked(listBindableNovelCharacters).mockResolvedValue([])
    vi.mocked(readFile).mockResolvedValue("")
  })

  afterEach(() => cleanup())

  it("会话状态读取失败 → 不猜章节、不读 draft.md（提取面显式 N/A）", async () => {
    vi.mocked(loadNovelSessionStatus).mockRejectedValueOnce(new Error("status gone"))
    render(<AssetLibraryView projectPath="/p/book" />)
    await waitFor(() => expect(screen.getByTestId("asset-library-row-genre_base")).toBeTruthy())
    expect(loadNovelSessionStatus).toHaveBeenCalledWith("/p/book")
    // 章节号来源失败 → chapterNumber 保持 null：绝不读某个「猜出来的」草稿路径。
    expect(readFile).not.toHaveBeenCalled()
    expect(screen.getByTestId("asset-extraction-gap-na").textContent).toContain("没有可检查的正文")
    expect(screen.getByTestId("asset-extraction-gap-summary").textContent).toContain("N/A")
  })

  it("wiki 人物实体读取失败 → wikiLoaded=false（面板报未装载，不当成零实体）", async () => {
    vi.mocked(loadNovelSessionStatus).mockResolvedValue({ current_task: { chapter_number: 3 } } as never)
    vi.mocked(readFile).mockResolvedValue("林晚推门而入。")
    vi.mocked(listBindableNovelCharacters).mockRejectedValueOnce(new Error("wiki gone"))
    render(<AssetLibraryView projectPath="/p/book" />)
    await waitFor(() =>
      expect(screen.getByTestId("asset-extraction-gap-na").textContent).toContain("wiki 人物实体未装载"),
    )
    expect(listBindableNovelCharacters).toHaveBeenCalledWith("/p/book")
    // wiki 未装载时不当成「零实体」：N/A 说明里逐条写清，汇总里的 wiki 计数记 0 但不冒充已验证。
    expect(screen.getByTestId("asset-extraction-gap-summary").textContent).toContain("wiki 人物实体：0")
  })

  it("未注入迁移实现 → 走生产关系库迁移（默认落点不是空操作）", async () => {
    vi.mocked(migrateRelationshipLibrary).mockClear()
    render(<AssetLibraryView projectPath="/p/book" snapshots={[snap({ libraryId: "relationship_edge" })]} />)
    fireEvent.click(screen.getByTestId("asset-library-migrate-relationships"))
    await waitFor(() => expect(screen.getByTestId("asset-library-migrate-status")).toBeTruthy())
    expect(migrateRelationshipLibrary).toHaveBeenCalledWith("/p/book")
    expect(screen.getByTestId("asset-library-migrate-status").textContent).toContain("没有可迁移的关系")
  })
})
