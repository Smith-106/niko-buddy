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
import { cleanup, render, screen } from "@testing-library/react"
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

afterEach(() => {
  cleanup()
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
