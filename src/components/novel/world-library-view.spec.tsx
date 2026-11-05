// @vitest-environment jsdom
/** WorldLibraryView：只读世界蓝图 + 设定中心（角色关系自由文本投影）+ 诚实空态/N/A。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { SettingProjection } from "@/lib/novel"
import type {
  RelationshipLibrarySnapshotView,
  WorldBlueprintSnapshot,
} from "./world-library-view"

const storeState = vi.hoisted(() => ({
  project: { id: "p1", name: "proj", path: "C:/proj" } as { id: string; name: string; path: string } | null,
  dataVersion: 1,
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key),
  }),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadAssetLibrarySnapshot: vi.fn(async () => ({ libraryId: "relationship_edge", present: false, entryCount: 0, contentHash: null, schemaVersion: null, conserved: false, health: null })),
    loadAssetLibraryArtifact: vi.fn(async () => null),
    loadWorldBlueprint: vi.fn(async () => null),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, fileExists: vi.fn(async () => false) }
})

import { loadAssetLibraryArtifact, loadAssetLibrarySnapshot, loadWorldBlueprint } from "@/lib/novel"
import { fileExists } from "@/commands/fs"

const { WorldLibraryView, loadRelationshipLibrarySnapshot, loadWorldBlueprintSnapshot } = await import("./world-library-view")

const emptySetting = { cast: [], edges: [], charactersWithoutRelations: 0 }

const settingWithCast = {
  cast: [
    { name: "林砚", location: "青石镇", status: "active", lastChapter: 7, isAlive: null, relationCount: 1 },
    { name: "赵九", location: null, status: null, lastChapter: null, isAlive: false, relationCount: 0 },
  ],
  edges: [{ from: "林砚", to: "苏晚", description: "师徒", lastChapter: 7 }],
  charactersWithoutRelations: 1,
}

const blueprint = {
  version: "1.0",
  worldType: "仙侠",
  layers: { geography: ["青石镇", "云海"], magicSystem: ["灵脉"] },
  crossRefs: [{ from: "magicSystem" as const, to: "geography" as const, term: "灵脉" }],
}

describe("WorldLibraryView", () => {
  afterEach(cleanup)

  it("无项目：显式空态", async () => {
    storeState.project = null
    render(<WorldLibraryView loader={async () => null} settingLoader={async () => emptySetting} />)
    await waitFor(() => expect(screen.getByTestId("world-library-no-project")).toBeTruthy())
    storeState.project = { id: "p1", name: "proj", path: "C:/proj" }
  })

  it("无蓝图：诚实空态（不造层）", async () => {
    render(<WorldLibraryView loader={async () => null} settingLoader={async () => emptySetting} />)
    await waitFor(() => expect(screen.getByTestId("world-library-empty")).toBeTruthy())
  })

  it("有蓝图：层计数/条目/交叉引用/校验结论齐全，未铺层显示 N/A", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({ blueprint, validation: { findings: [], verdict: "incomplete" } })}
        settingLoader={async () => emptySetting}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-layers")).toBeTruthy())
    expect(screen.getByTestId("world-library-layer-count-geography").textContent).toBe("2")
    expect(screen.getByTestId("world-library-layer-count-axioms").textContent).toBe("novel.worldLibrary.na")
    expect(screen.getByTestId("world-library-crossref-0").textContent).toBe("magicSystem → geography: 灵脉")
    expect(screen.getByTestId("world-library-verdict").textContent).toBe("novel.worldLibrary.verdictIncomplete")
    // 结构化徽章：多实体不再拼“、”文本墙，badge 数量等于实体数（空分支不动）
    expect(screen.getByTestId("world-library-layer-entries-geography").textContent).not.toContain("、")
    expect(screen.getByTestId("world-library-layer-entries-geography").textContent).not.toBe("青石镇、云海")
    expect(screen.getAllByTestId(/world-library-entry-geography-/)).toHaveLength(2)
    expect(screen.getByTestId("world-library-entry-geography-0").textContent).toBe("青石镇")
    expect(screen.getByTestId("world-library-entry-geography-1").textContent).toBe("云海")
    expect(screen.getAllByTestId(/world-library-entry-magicSystem-/)).toHaveLength(1)
    expect(screen.getByTestId("world-library-layer-entries-axioms").textContent).toBe("novel.worldLibrary.layerEmpty")
    expect(screen.queryAllByTestId(/world-library-entry-axioms-/)).toHaveLength(0)
  })

  it("装载失败：显式错误而非空态", async () => {
    render(
      <WorldLibraryView
        loader={async () => {
          throw new Error("boom")
        }}
        settingLoader={async () => emptySetting}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-error")).toBeTruthy())
    expect(screen.getByTestId("world-library-error").textContent).toContain("boom")
  })

  it("设定中心：角色/关系渲染 + 无关系缺口 + 三条 N/A", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({ blueprint, validation: { findings: [], verdict: "complete" } })}
        settingLoader={async () => settingWithCast}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("setting-center-cast")).toBeTruthy())
    expect(screen.getByTestId("setting-center-cast-林砚")).toBeTruthy()
    expect(screen.getByTestId("setting-center-edge-0").textContent).toBe("林砚 → 苏晚：师徒")
    // 缺章号必须显示 N/A，不得显示「最近第 0 章」
    expect(screen.getByTestId("setting-center-cast-赵九").textContent).toContain(
      "novel.settingCenter.lastChapterNa",
    )
    expect(screen.getByTestId("setting-center-cast-赵九").textContent).not.toContain('"chapter":0')
    expect(screen.getByTestId("setting-center-na-type").textContent).toBe("novel.settingCenter.naType")
    expect(screen.getByTestId("setting-center-na-strength")).toBeTruthy()
    expect(screen.getByTestId("setting-center-na-graph")).toBeTruthy()
  })

  it("设定中心装载失败：显式错误，不影响世界蓝图区块", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({ blueprint, validation: { findings: [], verdict: "complete" } })}
        settingLoader={async () => {
          throw new Error("state-broken")
        }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("setting-center-error")).toBeTruthy())
    expect(screen.getByTestId("setting-center-error").textContent).toContain("state-broken")
    expect(screen.getByTestId("world-library-layers")).toBeTruthy()
  })
})

describe("世界蓝图：文件存在但解析失败 ≠ 还没生成", () => {
  it("默认装载器在文件存在却读不出时抛错（进错误态，不伪装成空态）", async () => {
    const mod = await import("./world-library-view")
    const fsMod = await import("@/commands/fs")
    const novel = await import("@/lib/novel")
    const existsSpy = vi.spyOn(fsMod, "fileExists").mockResolvedValue(true)
    const loadSpy = vi.spyOn(novel, "loadWorldBlueprint").mockResolvedValue(null)
    await expect(mod.loadWorldBlueprintSnapshot("C:/p")).rejects.toThrow(/世界蓝图存在，但无法解析/)
    existsSpy.mockRestore()
    loadSpy.mockRestore()
  })
})

describe("结构化关系库回显（Wave 3B）", () => {
  afterEach(cleanup)

  it("已迁移：显示结构化边（kind/strength），N/A 类型与强度让位给真实数据", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({ blueprint, validation: { findings: [], verdict: "complete" } })}
        settingLoader={async () => settingWithCast}
        relationshipLoader={async () => ({
          entries: [
            { from: "林砚", to: "苏晚", kind: "mentor", strength: 60 },
            { from: "赵九", to: "林砚", kind: "unknown", note: "敌对" },
          ],
        })}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("setting-center-structured")).toBeTruthy())
    expect(screen.getByTestId("setting-center-structured-0").textContent).toBe("林砚 → 苏晚 · mentor · 60")
    // kind=unknown 且无强度 → 不编数字
    expect(screen.getByTestId("setting-center-structured-1").textContent).toBe("赵九 → 林砚 · unknown")
    expect(screen.queryByTestId("setting-center-na-type")).toBeNull()
    expect(screen.getByTestId("setting-center-structured-source")).toBeTruthy()
    // 图仍然 N/A（没有交互图真源）
    expect(screen.getByTestId("setting-center-na-graph")).toBeTruthy()
  })

  it("未迁移：关系库缺失时仍显示两条 N/A，不冒充有类型/强度", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({ blueprint, validation: { findings: [], verdict: "complete" } })}
        settingLoader={async () => settingWithCast}
        relationshipLoader={async () => null}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("setting-center-cast")).toBeTruthy())
    expect(screen.queryByTestId("setting-center-structured")).toBeNull()
    expect(screen.getByTestId("setting-center-na-type")).toBeTruthy()
    expect(screen.getByTestId("setting-center-na-strength")).toBeTruthy()
  })

  it("关系库装载失败：降级为未迁移，不阻塞世界蓝图区块", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({ blueprint, validation: { findings: [], verdict: "complete" } })}
        settingLoader={async () => settingWithCast}
        relationshipLoader={async () => {
          throw new Error("lib-broken")
        }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-layers")).toBeTruthy())
    expect(screen.queryByTestId("setting-center-structured")).toBeNull()
    expect(screen.getByTestId("setting-center-na-type")).toBeTruthy()
  })
})

describe("WorldLibraryView 覆盖补齐：默认装载器 + 校验结论渲染", () => {
  it("蓝图缺失且无文件 → loadWorldBlueprintSnapshot null（诚实空态上游）", async () => {
    vi.mocked(loadWorldBlueprint).mockResolvedValue(null)
    vi.mocked(fileExists).mockResolvedValue(false)
    await expect(loadWorldBlueprintSnapshot("C:/proj")).resolves.toBeNull()
  })

  it("蓝图损坏（文件存在但解析不出）→ throw 明确错误（非空态）", async () => {
    vi.mocked(loadWorldBlueprint).mockResolvedValue(null)
    vi.mocked(fileExists).mockResolvedValue(true)
    await expect(loadWorldBlueprintSnapshot("C:/proj")).rejects.toThrow("世界蓝图存在，但无法解析")
  })

  it("蓝图存在 → 返回 {blueprint, validation}（校验结论同源）", async () => {
    vi.mocked(loadWorldBlueprint).mockResolvedValue(blueprint as never)
    const snapshot = await loadWorldBlueprintSnapshot("C:/proj")
    expect(snapshot?.blueprint).toBe(blueprint)
    expect(snapshot?.validation.verdict).toMatch(/complete|incomplete/)
  })

  it("关系库 present + 产物齐全 → 结构化条目映射（from/to/kind/strength）", async () => {
    vi.mocked(loadAssetLibrarySnapshot).mockResolvedValueOnce({
      libraryId: "relationship_edge",
      present: true,
      entryCount: 1,
      contentHash: "abc",
      schemaVersion: 1,
      conserved: true,
      health: null,
    } as never)
    vi.mocked(loadAssetLibraryArtifact).mockResolvedValueOnce({
      entries: [{ from: "林砚", to: "赵九", kind: "师徒", strength: 8, note: "n", entryId: "e1", name: "x", toneTags: [], forbidPatterns: [], plotBeats: [] }],
    } as never)
    const view = await loadRelationshipLibrarySnapshot("C:/proj")
    expect(view?.entries).toEqual([{ from: "林砚", to: "赵九", kind: "师徒", strength: 8, note: "n" }])
  })

  it("关系库 present 但产物缺失 → null（按未迁移处理，不假装有类型）", async () => {
    vi.mocked(loadAssetLibrarySnapshot).mockResolvedValueOnce({
      libraryId: "relationship_edge",
      present: true,
      entryCount: 1,
      contentHash: "abc",
      schemaVersion: 1,
      conserved: true,
      health: null,
    } as never)
    vi.mocked(loadAssetLibraryArtifact).mockResolvedValueOnce(null)
    await expect(loadRelationshipLibrarySnapshot("C:/proj")).resolves.toBeNull()
  })

  it("校验 findings 非空 → finding 行渲染（error 红/warn 黄文案同源）", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({
          blueprint: blueprint as never,
          validation: {
            verdict: "incomplete",
            findings: [
              { code: "empty-layer", layer: "axioms", severity: "error", message: "公理层是空的" },
              { code: "thin-geo", layer: "geography", severity: "warn", message: "地理过薄" },
            ],
          } as never,
        })}
        settingLoader={async () => emptySetting}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-finding-0")).toBeTruthy())
    expect(screen.getByTestId("world-library-finding-0").textContent).toContain("公理层是空的")
    expect(screen.getByTestId("world-library-finding-0").className).toContain("text-destructive")
    expect(screen.getByTestId("world-library-finding-1").textContent).toContain("地理过薄")
    expect(screen.getByTestId("world-library-finding-1").className).toContain("text-warning-foreground")
  })
})

describe("WorldLibraryView · 分支补齐：取消守卫与空态变体", () => {
  beforeEach(() => {
    cleanup()
  })
  afterEach(cleanup)

  it("卸载后迟到的三路装载结果被丢弃（取消守卫，不写已卸载状态）", async () => {
    let resolveWorld: ((v: WorldBlueprintSnapshot | null) => void) | null = null
    let resolveSetting: ((v: SettingProjection) => void) | null = null
    let resolveRel: ((v: RelationshipLibrarySnapshotView | null) => void) | null = null
    const { container, unmount } = render(
      <WorldLibraryView
        loader={() => new Promise<WorldBlueprintSnapshot | null>((res) => { resolveWorld = res })}
        settingLoader={() => new Promise<SettingProjection>((res) => { resolveSetting = res })}
        relationshipLoader={() =>
          new Promise<RelationshipLibrarySnapshotView | null>((res) => { resolveRel = res })
        }
      />,
    )
    // 三路 effect 已触发（装载中），再卸载
    expect(resolveWorld).not.toBeNull()
    expect(resolveSetting).not.toBeNull()
    expect(resolveRel).not.toBeNull()
    unmount()
    await act(async () => {
      resolveWorld?.(null)
      resolveSetting?.(emptySetting as SettingProjection)
      resolveRel?.(null)
    })
    // 容器级断言：不受其它用例残留 DOM 干扰，只看本次渲染确已卸载
    expect(container.querySelector('[data-testid="world-library-view"]')).toBeNull()
  })

  it("卸载后迟到的三路装载失败同样被丢弃", async () => {
    let rejectWorld: ((e: unknown) => void) | null = null
    let rejectSetting: ((e: unknown) => void) | null = null
    let rejectRel: ((e: unknown) => void) | null = null
    const { container, unmount } = render(
      <WorldLibraryView
        loader={() => new Promise<WorldBlueprintSnapshot | null>((_, rej) => { rejectWorld = rej })}
        settingLoader={() => new Promise<SettingProjection>((_, rej) => { rejectSetting = rej })}
        relationshipLoader={() =>
          new Promise<RelationshipLibrarySnapshotView | null>((_, rej) => { rejectRel = rej })
        }
      />,
    )
    expect(rejectWorld).not.toBeNull()
    unmount()
    await act(async () => {
      rejectWorld?.(new Error("late world"))
      rejectSetting?.(new Error("late setting"))
      rejectRel?.(new Error("late rel"))
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="world-library-view"]')).toBeNull()
    expect(container.querySelector('[data-testid="world-library-error"]')).toBeNull()
  })

  it("蓝图存在但无法解析 → 错误态附带 world-blueprint.json 指引", async () => {
    render(
      <WorldLibraryView
        loader={async () => {
          throw new Error("世界蓝图存在，但无法解析")
        }}
        settingLoader={async () => emptySetting as SettingProjection}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-error")).toBeTruthy())
    const err = screen.getByTestId("world-library-error")
    expect(err.textContent).toContain("世界蓝图存在，但无法解析")
    expect(err.textContent).toContain("world-blueprint.json")
  })

  it("世界类型缺失 → 类型徽标回退 N/A", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({
          blueprint: { ...blueprint, worldType: "" } as never,
          validation: { findings: [], verdict: "incomplete" },
        })}
        settingLoader={async () => emptySetting as SettingProjection}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-world-type")).toBeTruthy())
    expect(screen.getByTestId("world-library-world-type").textContent).toContain(
      "novel.worldLibrary.na",
    )
  })

  it("无交叉引用 → 交叉引用空态（不渲染空列表）", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({
          blueprint: { ...blueprint, crossRefs: [] } as never,
          validation: { findings: [], verdict: "incomplete" },
        })}
        settingLoader={async () => emptySetting as SettingProjection}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-crossrefs-empty")).toBeTruthy())
    expect(screen.queryByTestId("world-library-crossref-0")).toBeNull()
  })

  it("无层级的 finding 仍渲染（key 回退 any）", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({
          blueprint: blueprint as never,
          validation: {
            verdict: "incomplete",
            findings: [{ code: "lonely-finding", severity: "error", message: "孤立问题" }],
          } as never,
        })}
        settingLoader={async () => emptySetting as SettingProjection}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("world-library-finding-0")).toBeTruthy())
    expect(screen.getByTestId("world-library-finding-0").textContent).toContain("孤立问题")
    expect(screen.getByTestId("world-library-finding-0").textContent).toContain("lonely-finding")
  })

  it("设定装载中 → 设定中心 loading 占位（世界蓝图区不受影响）", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({
          blueprint: blueprint as never,
          validation: { findings: [], verdict: "complete" } as never,
        })}
        settingLoader={() => new Promise<SettingProjection>(() => {})}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("setting-center-loading")).toBeTruthy())
    expect(screen.getByTestId("world-library-layers")).toBeTruthy()
  })

  it("设定有角色但零关系边 → 关系空态", async () => {
    render(
      <WorldLibraryView
        loader={async () => ({
          blueprint: blueprint as never,
          validation: { findings: [], verdict: "complete" } as never,
        })}
        settingLoader={async () => ({ ...settingWithCast, edges: [] }) as SettingProjection}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("setting-center-cast")).toBeTruthy())
    expect(screen.getByTestId("setting-center-edges-empty")).toBeTruthy()
    expect(screen.queryByTestId("setting-center-edge-0")).toBeNull()
  })
})
