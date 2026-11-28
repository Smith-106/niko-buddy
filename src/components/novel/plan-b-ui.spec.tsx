// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, waitFor } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  project: { id: "p1", name: "测试书", path: "/proj" } as { id: string; name: string; path: string } | null,
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  saveDeAiTieredOverrides: vi.fn(),
  loadDeAiTieredOverrides: vi.fn(),
  loadCraftPresetJournal: vi.fn(),
  loadCustomCraftPresets: vi.fn(),
  saveCustomCraftPresets: vi.fn(),
  applyCraftPresetToProject: vi.fn(),
  rollbackLastCraftPreset: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: Object.assign(
      (selector: (s: { project: typeof mocks.project }) => unknown) => selector({ project: mocks.project }),
      { getState: () => ({ project: mocks.project }) },
    ),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    writeFileAtomic: (...args: unknown[]) => mocks.writeFileAtomic(...args),
  }
})

vi.mock("@tauri-apps/api/path", () => ({
  join: async (...parts: string[]) => parts.join("/"),
}))

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadDeAiTieredOverrides: (...args: unknown[]) => mocks.loadDeAiTieredOverrides(...args),
    saveDeAiTieredOverrides: (...args: unknown[]) => mocks.saveDeAiTieredOverrides(...args),
    loadCraftPresetJournal: (...args: unknown[]) => mocks.loadCraftPresetJournal(...args),
    loadCustomCraftPresets: (...args: unknown[]) => mocks.loadCustomCraftPresets(...args),
    saveCustomCraftPresets: (...args: unknown[]) => mocks.saveCustomCraftPresets(...args),
    applyCraftPresetToProject: (...args: unknown[]) => mocks.applyCraftPresetToProject(...args),
    rollbackLastCraftPreset: (...args: unknown[]) => mocks.rollbackLastCraftPreset(...args),
  }
})

import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import { DeAiSkillEditor } from "./de-ai-skill-editor"
import { NovelCraftPresetPanel } from "@/components/settings/sections/novel-craft-preset-panel"

describe("Plan B UI — DeAiSkillEditor 新增/豁免 + NovelCraftPresetPanel 缺失提示/历史/导入", () => {
  beforeEach(() => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.loadDeAiTieredOverrides.mockResolvedValue(null)
    mocks.saveDeAiTieredOverrides.mockResolvedValue({ version: 1, updatedAt: 1, tierOverrides: {}, customEntries: [], disabledTerms: [] })
    mocks.loadCraftPresetJournal.mockResolvedValue({
      version: 1,
      entries: [
        {
          txId: "tx-1",
          presetId: "satirical-xiuxian",
          presetName: "现实痛点黑色讽刺修仙流",
          appliedAt: "2026-11-27T12:00:00.000Z",
          backupDir: ".niko-buddy/preset-backups/tx-1",
          status: "committed",
          files: [],
        },
      ],
    })
    mocks.loadCustomCraftPresets.mockResolvedValue([])
    mocks.saveCustomCraftPresets.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("DeAiSkillEditor Tab 2 支持新增自定义禁词与豁免内置词并一并落盘", async () => {
    render(<DeAiSkillEditor />)
    fireEvent.click(screen.getByText("结构化分级"))

    const input = await screen.findByTestId("deai-new-term-input")
    fireEvent.change(input, { target: { value: "机械圣体" } })
    fireEvent.click(screen.getByTestId("deai-add-term-btn"))

    // 豁免内置 1A 词「显然」
    fireEvent.click(screen.getByTestId("deai-toggle-disabled-显然"))

    fireEvent.click(screen.getByTestId("deai-save-table-btn"))
    await waitFor(() => expect(mocks.saveDeAiTieredOverrides).toHaveBeenCalledTimes(1))

    const savedPayload = mocks.saveDeAiTieredOverrides.mock.calls[0][1]
    expect(savedPayload.disabledTerms).toContain("显然")
    expect(savedPayload.customEntries.some((e: { term: string }) => e.term === "机械圣体")).toBe(true)
  })

  it("NovelCraftPresetPanel 渲染缺失技能提醒、历史列表，并支持导入自定义预设 JSON", async () => {
    render(
      <NovelCraftPresetPanel
        projectPath="/proj"
        novelConfig={DEFAULT_NOVEL_CONFIG}
        availableSkills={[]}
        onPresetApplied={vi.fn()}
        onRollbackApplied={vi.fn(async () => {})}
      />,
    )

    // 缺失技能警告框可见
    const missingBox = await screen.findByTestId("craft-preset-missing-skills")
    expect(missingBox.textContent).toContain("expert-satirical-capitalist-cultivation")

    // 事务历史折叠面板可见
    const historyBox = await screen.findByTestId("craft-preset-history")
    expect(historyBox.textContent).toContain("现实痛点黑色讽刺修仙流")

    // 导入自定义预设 JSON
    const fileInput = screen.getByTestId("craft-preset-import-input") as HTMLInputElement
    const payload = JSON.stringify({
      presets: [
        {
          id: "imported-sci-fi",
          name: "硬核太空歌剧流",
          genres: ["科幻"],
          tone: "冷峻史诗",
          primaryExpert: "expert-cuttlefish-hard-world-mystery",
          secondaryExpert: null,
          taskSkillNames: { outline: [], writing: ["long-form-drafting"], review: [] },
          extraPromptHint: "遵循轨道力学硬设定",
        },
      ],
    })
    const fakeFile = new File([payload], "custom-presets.json", { type: "application/json" })
    Object.defineProperty(fakeFile, "text", { value: async () => payload })
    fireEvent.change(fileInput, { target: { files: [fakeFile] } })

    await waitFor(() => expect(mocks.saveCustomCraftPresets).toHaveBeenCalledTimes(1))
    const select = screen.getByTestId("craft-preset-select") as HTMLSelectElement
    expect(select.value).toBe("imported-sci-fi")
  })
})
