// @vitest-environment jsdom
/** WorldLibraryView：只读世界蓝图 + 设定中心（角色关系自由文本投影）+ 诚实空态/N/A。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

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
    loadAssetLibrarySnapshot: async () => ({ libraryId: "relationship_edge", present: false, entryCount: 0, contentHash: null, schemaVersion: null, conserved: false, health: null }),
    loadAssetLibraryArtifact: async () => null,
  }
})

const { WorldLibraryView } = await import("./world-library-view")

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
    await expect(mod.loadWorldBlueprintSnapshot("C:/p")).rejects.toThrow(/exists but could not be parsed/)
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
