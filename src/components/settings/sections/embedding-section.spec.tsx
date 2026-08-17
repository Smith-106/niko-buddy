// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import type { ReactNode } from "react"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { EmbeddingSection } from "./embedding-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface ProjectLike {
  id: string
  name: string
  path: string
}

const DEFAULT_PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p/mybook" }

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    embeddingEnabled: false,
    embeddingEndpoint: "",
    embeddingApiKey: "",
    embeddingModel: "",
    embeddingOutputDimensionality: undefined,
    embeddingMaxChunkChars: undefined,
    embeddingOverlapChunkChars: undefined,
    ...overrides,
  } as SettingsDraft
}

const mocks = vi.hoisted(() => {
  const state: {
    project: ProjectLike | null
    embeddingConfig: Record<string, unknown>
  } = {
    project: null,
    embeddingConfig: {},
  }
  return {
    state,
    setDraft: vi.fn() as DraftSetter,
    t: vi.fn((key: string) => key),
    getEmbeddingCount: vi.fn(async () => 0),
    legacyVectorRowCount: vi.fn(async () => 0),
    getLastEmbeddingError: vi.fn(() => null),
    embedAllPages: vi.fn(async () => 0),
    dropLegacyVectorTable: vi.fn(async () => {}),
    testSettingsEmbeddingModel: vi.fn(async () => ({ model: "bge-m3", dimensions: 1024 })),
    fetchEmbeddingModelList: vi.fn(async () => ({ models: ["bge-m3"] })),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
}))

vi.mock("@/lib/embedding", () => ({
  dropLegacyVectorTable: mocks.dropLegacyVectorTable,
  embedAllPages: mocks.embedAllPages,
  getEmbeddingCount: mocks.getEmbeddingCount,
  getLastEmbeddingError: mocks.getLastEmbeddingError,
  legacyVectorRowCount: mocks.legacyVectorRowCount,
}))

vi.mock("@/lib/settings-model-list", () => ({
  fetchEmbeddingModelList: mocks.fetchEmbeddingModelList,
}))

vi.mock("@/lib/settings-model-test", () => ({
  testSettingsEmbeddingModel: mocks.testSettingsEmbeddingModel,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    type = "button",
    children,
    ...props
  }: {
    variant?: string
    size?: string
    type?: "button" | "submit" | "reset"
    children?: ReactNode
    [key: string]: unknown
  }) => (
    <button type={type} {...props}>
      {children}
    </button>
  ),
}))

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 受控包装：setDraft 同时更新 draft 状态与外部 spy，供输入类断言使用。 */
function ControlledSection({
  initial,
  setDraftSpy,
}: {
  initial?: SettingsDraft
  setDraftSpy?: DraftSetter
}) {
  const [draft, setDraft] = useState(initial ?? makeDraft())
  const setter: DraftSetter = (key, value) => {
    setDraftSpy?.(key, value)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }
  return <EmbeddingSection draft={draft} setDraft={setter} />
}

function expandPanel(): void {
  fireEvent.click(screen.getByTitle("settings.sections.llm.expand"))
}

describe("EmbeddingSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.project = null
    mocks.state.embeddingConfig = {}
    mocks.getEmbeddingCount.mockResolvedValue(0)
    mocks.legacyVectorRowCount.mockResolvedValue(0)
    mocks.getLastEmbeddingError.mockReturnValue(null)
    mocks.embedAllPages.mockResolvedValue(0)
    mocks.dropLegacyVectorTable.mockResolvedValue(undefined)
    mocks.testSettingsEmbeddingModel.mockResolvedValue({ model: "bge-m3", dimensions: 1024 })
    mocks.fetchEmbeddingModelList.mockResolvedValue({ models: ["bge-m3"] })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("默认折叠，点击展开/收起切换面板内容", () => {
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    expect(screen.getByTitle("settings.sections.llm.expand")).toBeTruthy()
    expect(screen.queryByText("settings.sections.embedding.endpoint")).toBeNull()

    expandPanel()
    expect(screen.getByTitle("settings.sections.llm.collapse")).toBeTruthy()
    expect(screen.getByText("settings.sections.embedding.endpoint")).toBeTruthy()

    fireEvent.click(screen.getByTitle("settings.sections.llm.collapse"))
    expect(screen.getByTitle("settings.sections.llm.expand")).toBeTruthy()
    expect(screen.queryByText("settings.sections.embedding.endpoint")).toBeNull()
  })

  it("标题行 label 按钮同样切换展开状态", () => {
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    fireEvent.click(screen.getByText("settings.sections.embedding.enableLabel"))
    expect(screen.getByTitle("settings.sections.llm.collapse")).toBeTruthy()
  })

  it("已启用时显示 activeBadge", () => {
    render(<EmbeddingSection draft={makeDraft({ embeddingEnabled: true })} setDraft={mocks.setDraft} />)
    expect(screen.getByText("settings.sections.llm.activeBadge")).toBeTruthy()
    expect(screen.queryByText("settings.sections.llm.configuredBadge")).toBeNull()
  })

  it("未启用但有配置时显示 configuredBadge", () => {
    render(
      <EmbeddingSection
        draft={makeDraft({ embeddingEnabled: false, embeddingEndpoint: "http://x" })}
        setDraft={mocks.setDraft}
      />,
    )
    expect(screen.getByText("settings.sections.llm.configuredBadge")).toBeTruthy()
  })

  it("未启用且无配置时不显示任何徽标", () => {
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    expect(screen.queryByText("settings.sections.llm.configuredBadge")).toBeNull()
    expect(screen.queryByText("settings.sections.llm.activeBadge")).toBeNull()
  })

  it("toggle 从关闭切到开启：写回 store 并自动展开", () => {
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    expect(screen.getByTitle("settings.sections.llm.expand")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("settings.sections.llm.activate"))
    expect(mocks.setDraft).toHaveBeenCalledWith("embeddingEnabled", true)
    expect(screen.getByTitle("settings.sections.llm.collapse")).toBeTruthy()
  })

  it("toggle 从开启切到关闭：写回 store", () => {
    render(<EmbeddingSection draft={makeDraft({ embeddingEnabled: true })} setDraft={mocks.setDraft} />)
    fireEvent.click(screen.getByLabelText("settings.sections.llm.deactivate"))
    expect(mocks.setDraft).toHaveBeenCalledWith("embeddingEnabled", false)
  })

  it("endpoint 与 apiKey 输入写回 draft", () => {
    render(<ControlledSection setDraftSpy={mocks.setDraft} />)
    expandPanel()

    const endpoint = screen.getByPlaceholderText("http://127.0.0.1:1234/v1/embeddings") as HTMLInputElement
    fireEvent.change(endpoint, { target: { value: "http://new:8080/v1/embeddings" } })
    expect(mocks.setDraft).toHaveBeenCalledWith("embeddingEndpoint", "http://new:8080/v1/embeddings")
    expect(endpoint.value).toBe("http://new:8080/v1/embeddings")

    const apiKey = screen.getByPlaceholderText("settings.sections.embedding.apiKeyPlaceholder") as HTMLInputElement
    fireEvent.change(apiKey, { target: { value: "sk-123" } })
    expect(mocks.setDraft).toHaveBeenCalledWith("embeddingApiKey", "sk-123")
    expect(apiKey.type).toBe("password")
  })

  it("模型输入写回 draft", () => {
    render(<ControlledSection setDraftSpy={mocks.setDraft} />)
    expandPanel()

    const input = screen.getByPlaceholderText("settings.sections.shared.modelManualPlaceholder") as HTMLInputElement
    fireEvent.change(input, { target: { value: "bge-large" } })
    expect(mocks.setDraft).toHaveBeenCalledWith("embeddingModel", "bge-large")
    expect(input.value).toBe("bge-large")
  })

  it("outputDimensionality 输入按正整数解析", () => {
    render(<ControlledSection setDraftSpy={mocks.setDraft} />)
    expandPanel()
    const input = screen.getByPlaceholderText("768") as HTMLInputElement

    fireEvent.change(input, { target: { value: "768" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOutputDimensionality", 768)
    expect(input.value).toBe("768")

    fireEvent.change(input, { target: { value: "12" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOutputDimensionality", 12)
    expect(input.value).toBe("12")

    fireEvent.change(input, { target: { value: "3.7" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOutputDimensionality", 3)

    fireEvent.change(input, { target: { value: "" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOutputDimensionality", undefined)
    expect(input.value).toBe("")

    fireEvent.change(input, { target: { value: "0" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOutputDimensionality", undefined)

    fireEvent.change(input, { target: { value: "-3" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOutputDimensionality", undefined)

    fireEvent.change(input, { target: { value: "abc" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOutputDimensionality", undefined)
  })

  it("maxChunkChars 输入：空置 undefined，数字写回", () => {
    render(
      <ControlledSection
        initial={makeDraft({ embeddingMaxChunkChars: 1000 })}
        setDraftSpy={mocks.setDraft}
      />,
    )
    expandPanel()
    const input = screen.getByPlaceholderText("1000") as HTMLInputElement

    fireEvent.change(input, { target: { value: "1200" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingMaxChunkChars", 1200)
    expect(input.value).toBe("1200")

    fireEvent.change(input, { target: { value: "" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingMaxChunkChars", undefined)
  })

  it("overlapChunkChars 输入：空置 undefined，数字写回", () => {
    render(
      <ControlledSection
        initial={makeDraft({ embeddingOverlapChunkChars: 200 })}
        setDraftSpy={mocks.setDraft}
      />,
    )
    expandPanel()
    const input = screen.getByPlaceholderText("200") as HTMLInputElement

    fireEvent.change(input, { target: { value: "250" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOverlapChunkChars", 250)
    expect(input.value).toBe("250")

    fireEvent.change(input, { target: { value: "" } })
    expect(mocks.setDraft).toHaveBeenLastCalledWith("embeddingOverlapChunkChars", undefined)
  })

  it("有项目时刷新统计并写入 chunkCount / legacyCount / lastError", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getEmbeddingCount.mockResolvedValue(42)
    mocks.legacyVectorRowCount.mockResolvedValue(7)
    mocks.getLastEmbeddingError.mockReturnValue("embed err")
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    expect(mocks.getEmbeddingCount).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.legacyVectorRowCount).toHaveBeenCalledWith("/p/mybook")
    expandPanel()
    expect(screen.getByText(/settings.sections.embedding.chunkCount/)).toBeTruthy()
    expect(screen.getByText("settings.sections.embedding.lastErrorHeading")).toBeTruthy()
    expect(screen.getByText("embed err")).toBeTruthy()
  })

  it("统计拉取失败时 chunkCount 置空但仍读 lastError", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getEmbeddingCount.mockRejectedValue(new Error("count-fail"))
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    expect(mocks.getLastEmbeddingError).toHaveBeenCalled()
    expandPanel()
    expect(screen.getByText(/settings.sections.embedding.chunkCount/)).toBeTruthy()
  })

  it("无项目时跳过统计拉取", async () => {
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expect(mocks.getEmbeddingCount).not.toHaveBeenCalled()
    expect(mocks.legacyVectorRowCount).not.toHaveBeenCalled()
  })

  it("showLegacyMigration：legacyCount>0 且 chunkCount 为 null 或 0 时提示", async () => {
    // 每次用新的 project 对象引用触发 refreshStats 重跑（useCallback 依赖 project）
    mocks.state.project = { ...DEFAULT_PROJECT, id: "p1" }
    mocks.getEmbeddingCount.mockResolvedValue(1)
    mocks.legacyVectorRowCount.mockResolvedValue(3)
    const { rerender } = render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()
    expect(screen.queryByText("settings.sections.embedding.legacyPromptTitle")).toBeNull()

    // 统计失败 → chunkCount=null，legacyCount 保持 3 → 提示
    mocks.state.project = { ...DEFAULT_PROJECT, id: "p2" }
    mocks.getEmbeddingCount.mockRejectedValue(new Error("x"))
    rerender(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expect(screen.getByText("settings.sections.embedding.legacyPromptTitle")).toBeTruthy()

    // chunkCount=0 → 仍提示
    mocks.state.project = { ...DEFAULT_PROJECT, id: "p3" }
    mocks.getEmbeddingCount.mockResolvedValue(0)
    rerender(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expect(screen.getByText("settings.sections.embedding.legacyPromptTitle")).toBeTruthy()

    // chunkCount>0 → 不再提示
    mocks.state.project = { ...DEFAULT_PROJECT, id: "p4" }
    mocks.getEmbeddingCount.mockResolvedValue(9)
    rerender(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expect(screen.queryByText("settings.sections.embedding.legacyPromptTitle")).toBeNull()
  })

  it("legacyCount 为 0 时不显示迁移提示", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getEmbeddingCount.mockResolvedValue(0)
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()
    expect(screen.queryByText("settings.sections.embedding.legacyPromptTitle")).toBeNull()
  })

  it("reindex 全流程：进度回调 → done 文案 → 再次刷新统计", async () => {
    mocks.state.project = DEFAULT_PROJECT
    let progressCb: ((done: number, total: number) => void) | null = null
    let release: () => void = () => {}
    mocks.embedAllPages.mockImplementation(
      async (_p: string, _cfg: unknown, progress: (done: number, total: number) => void) => {
        progressCb = progress
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return 7
      },
    )
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    const reindexBtn = screen.getByText("settings.sections.embedding.reindexAll") as HTMLButtonElement
    expect(reindexBtn.disabled).toBe(false)
    fireEvent.click(reindexBtn)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // running 状态：进度文案 + 按钮禁用
    progressCb?.(3, 10)
    progressCb?.(5, 10)
    expect(screen.getByText("settings.sections.embedding.reindexing")).toBeTruthy()
    expect((screen.getByText("settings.sections.embedding.reindexing") as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText(/settings.sections.embedding.reindexDone/)).toBeTruthy()
    // 完成后再次刷新统计（第 2 次调用）
    expect(mocks.getEmbeddingCount).toHaveBeenCalledTimes(2)
    expect(mocks.embedAllPages).toHaveBeenCalledWith("/p/mybook", mocks.state.embeddingConfig, expect.any(Function))
  })

  it("reindex 无项目时按钮禁用", async () => {
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()
    const reindexBtn = screen.getByText("settings.sections.embedding.reindexAll") as HTMLButtonElement
    expect(reindexBtn.disabled).toBe(true)
    fireEvent.click(reindexBtn)
    await flushAsync()
    expect(mocks.embedAllPages).not.toHaveBeenCalled()
  })

  it("drop legacy：删除旧表并显示完成文案", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getEmbeddingCount.mockResolvedValue(0)
    mocks.legacyVectorRowCount.mockResolvedValue(5)
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.embedding.dropLegacy"))
    await flushAsync()

    expect(mocks.dropLegacyVectorTable).toHaveBeenCalledWith("/p/mybook")
    expect(screen.getByText("settings.sections.embedding.dropLegacyDone")).toBeTruthy()
  })

  it("drop legacy 无项目时按钮禁用（项目被切走后 legacyCount 仍在）", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.getEmbeddingCount.mockResolvedValue(0)
    mocks.legacyVectorRowCount.mockResolvedValue(5)
    const { rerender } = render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()
    expect(screen.getByText("settings.sections.embedding.dropLegacy")).toBeTruthy()

    // 切走项目后按钮保留但禁用
    mocks.state.project = null
    rerender(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()
    const btn = screen.getByText("settings.sections.embedding.dropLegacy") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    await flushAsync()
    expect(mocks.dropLegacyVectorTable).not.toHaveBeenCalled()
  })

  it("测试模型成功并拉取模型列表", async () => {
    mocks.state.project = DEFAULT_PROJECT
    const draft = makeDraft({ embeddingModel: "bge-m3", embeddingEndpoint: "http://x" })
    render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await flushAsync()

    expect(mocks.testSettingsEmbeddingModel).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, model: "bge-m3" }),
    )
    expect(mocks.fetchEmbeddingModelList).toHaveBeenCalled()
    expect(screen.getByText(/settings.sections.embedding.testSuccessWithDimensions/)).toBeTruthy()
    expect(screen.getByText(/settings.sections.shared.modelListSuccess/)).toBeTruthy()
    // 模型下拉出现（含已选模型）
    const select = screen.getByRole("combobox")
    expect(select).toBeTruthy()
    fireEvent.change(select, { target: { value: "bge-m3" } })
    expect(mocks.setDraft).toHaveBeenCalledWith("embeddingModel", "bge-m3")
  })

  it("测试模型失败时短路，不拉取模型列表", async () => {
    const draft = makeDraft({ embeddingModel: "bge-m3" })
    mocks.testSettingsEmbeddingModel.mockRejectedValue(new Error("test-fail"))
    render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await flushAsync()

    expect(screen.getByText(/settings.sections.shared.testFailed/)).toBeTruthy()
    expect(mocks.fetchEmbeddingModelList).not.toHaveBeenCalled()
  })

  it("无模型时跳过测试直接拉取模型列表", async () => {
    const draft = makeDraft({ embeddingModel: "  " })
    render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await flushAsync()

    expect(mocks.testSettingsEmbeddingModel).not.toHaveBeenCalled()
    expect(mocks.fetchEmbeddingModelList).toHaveBeenCalled()
    expect(screen.getByText(/settings.sections.shared.modelListSuccess/)).toBeTruthy()
  })

  it("拉取模型列表失败时显示失败消息", async () => {
    const draft = makeDraft({ embeddingModel: "bge-m3" })
    mocks.fetchEmbeddingModelList.mockRejectedValue(new Error("list-fail"))
    render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await flushAsync()

    expect(screen.getByText(/settings.sections.shared.modelListFailed/)).toBeTruthy()
  })

  it("测试模型失败（非 Error 抛出）时显示字符串消息", async () => {
    const draft = makeDraft({ embeddingModel: "bge-m3" })
    mocks.testSettingsEmbeddingModel.mockRejectedValue("plain-string-failure")
    render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await flushAsync()

    expect(screen.getByText(/settings.sections.shared.testFailed/)).toBeTruthy()
    expect(mocks.fetchEmbeddingModelList).not.toHaveBeenCalled()
  })

  it("拉取模型列表失败（非 Error 抛出）时显示字符串消息", async () => {
    const draft = makeDraft({ embeddingModel: "bge-m3" })
    mocks.fetchEmbeddingModelList.mockRejectedValue("plain-list-failure")
    render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await flushAsync()

    expect(screen.getByText(/settings.sections.shared.modelListFailed/)).toBeTruthy()
  })

  it("测试进行中按钮禁用并显示 testing 文案", async () => {
    const draft = makeDraft({ embeddingModel: "bge-m3" })
    let releaseTest: (value: unknown) => void = () => {}
    mocks.testSettingsEmbeddingModel.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseTest = resolve
        }),
    )
    mocks.fetchEmbeddingModelList.mockResolvedValue({ models: [] })
    render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const btn = screen.getAllByText("settings.sections.shared.testing").find(
      (el) => el.tagName === "BUTTON",
    ) as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    await act(async () => {
      releaseTest({ model: "bge-m3", dimensions: 1024 })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it("endpoint 或 apiKey 变化时重置模型选项与列表状态", async () => {
    mocks.fetchEmbeddingModelList.mockResolvedValue({ models: ["a", "b"] })
    const draft = makeDraft({ embeddingModel: "x" })
    const { rerender } = render(<EmbeddingSection draft={draft} setDraft={mocks.setDraft} />)
    await flushAsync()
    expandPanel()

    fireEvent.click(screen.getByText("settings.sections.shared.testModel"))
    await flushAsync()
    expect(screen.getByRole("combobox")).toBeTruthy()

    rerender(<EmbeddingSection draft={makeDraft({ embeddingModel: "x", embeddingEndpoint: "http://other" })} setDraft={mocks.setDraft} />)
    await flushAsync()
    expect(screen.queryByRole("combobox")).toBeNull()
  })
})
