// @vitest-environment jsdom
/**
 * story-mode-library-view.spec.tsx — 推进模式库视图（只读浏览）契约。
 *
 * 覆盖：
 *   1. 有效 pacing_pattern → 模式卡片渲染（displayName＋阶段名＋出入场门）＋快照「已生成」；
 *   2. 文件缺失 → 快照诚实标「未生成」，不造卡片；
 *   3. 损坏 JSON → 快照显读取失败原因，不伪装成空库；
 *   4. 重复 phase key 条目 → 契约违反行 fail-loud，不整页崩。
 *
 * 约定：mock `@/commands/fs` 的 readFile（store 经它读盘）；产物 JSON 用 barrel 的
 * `buildLibraryArtifact` 构造（守恒口径与线上一致）；不用 Object.hasOwn/.at。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { StoryModeLibraryView } from "./story-mode-library-view"
import { buildLibraryArtifact } from "@/lib/novel"

const fs = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("not found: pacing_pattern.json")
  }),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fs.readFile,
  }
})

/** 快照装载器的注入点；无实现时委托 barrel 真实现（既有用例语义零变化）。 */
const barrelMock = vi.hoisted(() => ({ loadSnapshot: vi.fn() }))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadAssetLibrarySnapshot: ((...args: Parameters<typeof actual.loadAssetLibrarySnapshot>) =>
      barrelMock.loadSnapshot.getMockImplementation()
        ? barrelMock.loadSnapshot(...args)
        : actual.loadAssetLibrarySnapshot(...args)) as typeof actual.loadAssetLibrarySnapshot,
  }
})

afterEach(() => {
  cleanup()
  barrelMock.loadSnapshot.mockReset()
})

const STANDARD_MODE = {
  modeId: "m-standard",
  displayName: "标准推进",
  phases: [
    {
      key: "outline",
      name: "大纲",
      entryGates: [],
      exitGates: ["consistency"],
      artifacts: ["volume-strategy-card"],
    },
    {
      key: "draft",
      name: "草稿",
      entryGates: ["consistency"],
      exitGates: ["consistency", "anti_ai"],
      artifacts: [],
    },
    {
      key: "polish",
      name: "润色",
      entryGates: ["anti_ai"],
      exitGates: [],
      artifacts: ["beat-board"],
    },
  ],
}

const SPRINT_MODE = {
  modeId: "m-sprint",
  displayName: "疾速推进",
  phases: [
    { key: "sketch", name: "速写", entryGates: [], exitGates: ["consistency"], artifacts: [] },
    { key: "finalize", name: "定稿", entryGates: ["consistency"], exitGates: ["quality"], artifacts: [] },
  ],
}

/** 用生成器同款口径构造 pacing_pattern.json 内容（守恒通过）。 */
function pacingJson(modes: unknown[]): string {
  const artifact = buildLibraryArtifact({
    libraryId: "pacing_pattern",
    generatorVersion: "spec",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: modes as never[],
  })
  return JSON.stringify(artifact)
}

describe("StoryModeLibraryView（推进模式库只读浏览）", () => {
  it("有效快照：模式卡片渲染 displayName＋阶段名＋出入场门，快照标已生成", async () => {
    fs.readFile.mockResolvedValue(pacingJson([STANDARD_MODE, SPRINT_MODE]))
    render(<StoryModeLibraryView projectPath="/p" />)

    expect(await screen.findByTestId("story-mode-library-view")).toBeTruthy()
    expect(await screen.findByTestId("story-mode-list")).toBeTruthy()
    const snapshot = await screen.findByTestId("story-mode-snapshot")
    expect(snapshot.textContent).toContain("已生成")
    expect(snapshot.textContent).toContain("2")
    expect((await screen.findByTestId("story-mode-summary")).textContent).toContain("2 个推进模式")

    const standard = await screen.findByTestId("story-mode-card-m-standard")
    expect(standard.textContent).toContain("标准推进")
    expect(standard.textContent).toContain("大纲")
    expect(standard.textContent).toContain("草稿")
    expect(standard.textContent).toContain("润色")
    expect(standard.textContent).toContain("设定一致性")
    expect(standard.textContent).toContain("反 AI 味")
    expect(screen.getByTestId("story-mode-phase-m-standard-draft")).toBeTruthy()

    const sprint = await screen.findByTestId("story-mode-card-m-sprint")
    expect(sprint.textContent).toContain("疾速推进")
    expect(sprint.textContent).toContain("速写")
    expect(sprint.textContent).toContain("文学质量")
  })

  it("文件缺失：快照诚实标「未生成」，不造卡片", async () => {
    fs.readFile.mockRejectedValue(new Error("not found: pacing_pattern.json"))
    render(<StoryModeLibraryView projectPath="/p" />)

    const snapshot = await screen.findByTestId("story-mode-snapshot")
    expect(snapshot.textContent).toContain("未生成")
    expect(await screen.findByTestId("story-mode-list")).toBeTruthy()
    expect((await screen.findByTestId("story-mode-empty")).textContent).toContain("未生成")
    expect(screen.queryByTestId("story-mode-card-m-standard")).toBeNull()
  })

  it("损坏 JSON：快照显读取失败原因，不伪装成空库", async () => {
    fs.readFile.mockResolvedValue("not json{{{")
    render(<StoryModeLibraryView projectPath="/p" />)

    const snapshot = await screen.findByTestId("story-mode-snapshot")
    expect(snapshot.textContent).toContain("解析失败")
    expect(snapshot.textContent).not.toContain("未生成")
  })

  it("重复 phase key 条目：契约违反行 fail-loud，不整页崩", async () => {
    const dup = {
      modeId: "m-dup",
      displayName: "重复模式",
      phases: [
        { key: "p1", name: "阶段一", entryGates: [], exitGates: [], artifacts: [] },
        { key: "p1", name: "阶段一重名", entryGates: [], exitGates: [], artifacts: [] },
      ],
    }
    fs.readFile.mockResolvedValue(pacingJson([dup]))
    render(<StoryModeLibraryView projectPath="/p" />)

    const invalid = await screen.findByTestId("story-mode-invalid")
    expect(invalid.textContent).toContain("重复的 phase key")
    expect(screen.queryByTestId("story-mode-card-m-dup")).toBeNull()
    // 文件存在且守恒通过 → 快照仍标已生成（坏的是条目契约，不是快照缺失）。
    expect((await screen.findByTestId("story-mode-snapshot")).textContent).toContain("已生成")
  })
})

describe("StoryModeLibraryView（语句收口）：空项目路径 / 装载器抛错", () => {
  it("空项目路径：不读盘，落「未生成」诚实空态并说明还没生成节奏模式", async () => {
    fs.readFile.mockClear()
    render(<StoryModeLibraryView projectPath="" />)

    // 未选项目 → 一次读盘都不发起
    expect(fs.readFile).not.toHaveBeenCalled()

    await screen.findByTestId("story-mode-list")
    expect((await screen.findByTestId("story-mode-summary")).textContent).toContain("共 0 个推进模式")
    expect((await screen.findByTestId("story-mode-snapshot")).textContent).toContain("未生成")
    const empty = await screen.findByTestId("story-mode-empty")
    expect(empty.textContent).toContain("本项目尚未生成节奏模式")
    expect(screen.queryByTestId("story-mode-invalid")).toBeNull()
  })

  it("快照装载器抛错：不臆造模式，落诚实空态且不整页崩", async () => {
    barrelMock.loadSnapshot.mockRejectedValue(new Error("snapshot boom"))
    render(<StoryModeLibraryView projectPath="/p" />)

    expect(await screen.findByTestId("story-mode-library-view")).toBeTruthy()
    // 装载失败 ⇒ 空态（未生成），且错误原因不写进快照区（那是「缺文件」语义）
    const snapshot = await screen.findByTestId("story-mode-snapshot")
    expect(snapshot.textContent).toContain("未生成")
    expect(snapshot.textContent).not.toContain("读取失败")
    expect((await screen.findByTestId("story-mode-summary")).textContent).toContain("共 0 个推进模式")
    expect(screen.queryByTestId("story-mode-card-m-standard")).toBeNull()
    expect(barrelMock.loadSnapshot).toHaveBeenCalledWith("/p", "pacing_pattern")
  })
})

describe("StoryModeLibraryView（分支收口）：守恒失配 / 有快照无条目 / 卸载取消", () => {
  it("快照守恒失配：下一步提示先核对守恒，快照区标「疑似手工篡改」", async () => {
    barrelMock.loadSnapshot.mockResolvedValue({
      libraryId: "pacing_pattern",
      present: true,
      entryCount: 1,
      contentHash: "deadbeef",
      schemaVersion: "1",
      conserved: false,
      health: null,
    })
    fs.readFile.mockResolvedValue(pacingJson([]))
    render(<StoryModeLibraryView projectPath="/p" />)

    const snapshot = await screen.findByTestId("story-mode-snapshot")
    expect(snapshot.textContent).toContain("守恒失配（疑似手工篡改）")
    expect(snapshot.textContent).not.toContain("守恒校验通过")
    // 页面顶部「下一步」也据此改口径
    expect(document.body.textContent).toContain("先核对守恒")
  })

  it("有快照但 0 条目：说「暂无可展示」而不是「尚未生成」", async () => {
    fs.readFile.mockResolvedValue(pacingJson([]))
    render(<StoryModeLibraryView projectPath="/p" />)

    const empty = await screen.findByTestId("story-mode-empty")
    expect(empty.textContent).toContain("暂无可展示的推进模式")
    expect(empty.textContent).not.toContain("本项目尚未生成节奏模式")
    expect((await screen.findByTestId("story-mode-snapshot")).textContent).toContain("已生成")
  })

  it("装载未完成就卸载：晚到的结果不写状态（取消守卫拦下，不崩）", async () => {
    let release: (value: string) => void = () => {}
    // 两个读盘（快照 + 条目）共用同一个未决 promise：卸载后一起晚到。
    const shared = new Promise<string>((resolve) => {
      release = resolve
    })
    fs.readFile.mockImplementation(() => shared)
    const { unmount } = render(<StoryModeLibraryView projectPath="/p" />)
    await screen.findByTestId("story-mode-library-view")
    unmount()
    release(pacingJson([STANDARD_MODE]))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // 卸载后组件不再在文档里；晚到的 setState 被取消守卫拦下（无报错、无残留卡片）
    expect(screen.queryByTestId("story-mode-library-view")).toBeNull()
    expect(screen.queryByTestId("story-mode-card-m-standard")).toBeNull()
  })

  it("装载抛错且已卸载：catch 里的取消守卫也拦住（不写状态、不报错）", async () => {
    let fail: (reason: unknown) => void = () => {}
    barrelMock.loadSnapshot.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const { unmount } = render(<StoryModeLibraryView projectPath="/p" />)
    await screen.findByTestId("story-mode-library-view")
    unmount()
    fail(new Error("late boom"))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByTestId("story-mode-library-view")).toBeNull()
  })
})
