// @vitest-environment jsdom
/**
 * PersonaCritiquePanel — 多人格咨询式评审面板全分支覆盖。
 * store 与外部依赖全部 vi.mock（vi.hoisted 可写 state 模式，参照 src/App.spec.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, setupDomGlobals, waitFor } from "@/test-helpers/component-test-utils"
import { PersonaCritiquePanel } from "./persona-critique-panel"
import type { PersonaCritiqueResult } from "@/lib/novel/persona-sidecar-runner"

interface CritiqueResultLike {
  ok: boolean
  reason?: "draft-not-ready" | "draft-missing" | "empty-personas"
  draftStatus?: string
  results: PersonaCritiqueResult[]
}

const mocks = vi.hoisted(() => {
  const wiki = { llmConfig: { provider: "openai", apiKey: "k", model: "m" } }
  return {
    wiki,
    t: vi.fn((key: string, opts?: { status?: string }) => (opts?.status ? `${key}::${opts.status}` : key)),
    hasUsableLlm: vi.fn(() => true),
    runPersonaCritique: vi.fn(async (): Promise<CritiqueResultLike> => ({ ok: true, results: [] })),
    loadNovelSessionStatus: vi.fn<(projectPath: string) => Promise<NovelSessionStatus | null>>(async () => null),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { llmConfig: unknown }) => unknown) => selector(mocks.wiki),
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: mocks.hasUsableLlm,
}))

vi.mock("@/lib/novel/persona-sidecar-runner", () => ({
  DEFAULT_PERSONA_IDS: ["critic", "empath", "devil", "reader"],
  PERSONA_CATALOG: {
    critic: { id: "critic", label: "挑剔者", systemPrompt: "" },
    empath: { id: "empath", label: "共情者", systemPrompt: "" },
    devil: { id: "devil", label: "魔鬼设师", systemPrompt: "" },
    reader: { id: "reader", label: "读者代表", systemPrompt: "" },
  },
  runPersonaCritique: mocks.runPersonaCritique,
}))

vi.mock("@/lib/novel/novel-session-status", () => ({
  loadNovelSessionStatus: mocks.loadNovelSessionStatus,
}))

const okResults: PersonaCritiqueResult[] = [
  {
    personaId: "critic",
    label: "挑剔者",
    status: "ok",
    summary: "节奏略拖",
    findings: ["开头慢", "对话平"],
    writtenPath: "/p/.novel/sidecars/personas/critic.json",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    personaId: "empath",
    label: "共情者",
    status: "error",
    error: "llm boom",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    personaId: "devil",
    label: "魔鬼设师",
    status: "skipped",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
]

function renderPanel(props: { projectPath?: string; onClose?: () => void; draftId?: string } = {}) {
  return render(
    <PersonaCritiquePanel
      projectPath={props.projectPath ?? "/p"}
      onClose={props.onClose ?? (() => {})}
      draftId={props.draftId}
    />,
  )
}

function clickRun(): HTMLElement {
  const btn = screen.getByRole("button", { name: "novel.persona.run" })
  fireEvent.click(btn)
  return btn
}

describe("PersonaCritiquePanel", () => {
  beforeEach(() => {
    setupDomGlobals()
    vi.clearAllMocks()
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.runPersonaCritique.mockResolvedValue({ ok: true, results: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
  })

  it("基础渲染：标题、隔离提示、4 个默认勾选人格、关闭按钮", () => {
    const onClose = vi.fn()
    renderPanel({ onClose })
    expect(screen.getByText("novel.persona.title")).toBeTruthy()
    expect(screen.getByText("novel.persona.advisoryHint")).toBeTruthy()
    expect(screen.getByText("novel.persona.isolationTitle")).toBeTruthy()
    expect(screen.getByText("挑剔者")).toBeTruthy()
    expect(screen.getByText("共情者")).toBeTruthy()
    expect(screen.getByText("魔鬼设师")).toBeTruthy()
    expect(screen.getByText("读者代表")).toBeTruthy()
    for (const label of ["挑剔者", "共情者", "魔鬼设师", "读者代表"]) {
      expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true")
    }
    // 无 draftId / 未加载状态：不显示 draftMeta
    expect(screen.queryByText(/novel\.persona\.draftMeta/)).toBeNull()
    // 关闭按钮
    fireEvent.click(screen.getByRole("button", { name: "common.close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("toggle 人格勾选状态", () => {
    renderPanel()
    const critic = screen.getByRole("button", { name: "挑剔者" })
    fireEvent.click(critic)
    expect(critic.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(critic)
    expect(critic.getAttribute("aria-pressed")).toBe("true")
  })

  it("draftIdProp 提供时直接显示 draftMeta", () => {
    renderPanel({ draftId: "draft-1" })
    expect(screen.getByText(/novel\.persona\.draftMeta/)).toBeTruthy()
  })

  it("未配置可用 LLM：提示 needLlm 且不调用 runner", () => {
    mocks.hasUsableLlm.mockReturnValue(false)
    renderPanel()
    clickRun()
    expect(screen.getByText("novel.persona.needLlm")).toBeTruthy()
    expect(mocks.runPersonaCritique).not.toHaveBeenCalled()
  })

  it("无 draftId（status 为 null）：提示 noDraft", async () => {
    renderPanel()
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.noDraft")).toBeTruthy())
    expect(mocks.loadNovelSessionStatus).toHaveBeenCalledWith("/p")
  })

  it("loadNovelSessionStatus 解析 draft.draft_id；二次运行复用 resolvedDraftId", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue({
      draft: { draft_id: "draft-9", draft_status: "ready" },
      current_task: { conversation_id: "conv-9" },
    })
    renderPanel()
    clickRun()
    await waitFor(() => expect(mocks.runPersonaCritique).toHaveBeenCalledTimes(1))
    expect(mocks.runPersonaCritique).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "draft-9", projectPath: "/p" }),
    )
    // draftMeta 显示已解析 draft
    expect(screen.getByText(/novel\.persona\.draftMeta/)).toBeTruthy()
    expect(mocks.loadNovelSessionStatus).toHaveBeenCalledTimes(1)

    // 第二次运行不再加载 status
    clickRun()
    await waitFor(() => expect(mocks.runPersonaCritique).toHaveBeenCalledTimes(2))
    expect(mocks.loadNovelSessionStatus).toHaveBeenCalledTimes(1)
  })

  it("status 无 draft_id 时回退 current_task.conversation_id", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue({
      draft: { draft_id: null, draft_status: "ready" },
      current_task: { conversation_id: "conv-7" },
    })
    renderPanel()
    clickRun()
    await waitFor(() =>
      expect(mocks.runPersonaCritique).toHaveBeenCalledWith(expect.objectContaining({ draftId: "conv-7" })),
    )
  })

  it("status 仅有 draft_status：noDraft 报错 + draftMeta 仍显示状态", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue({
      draft: { draft_id: null, draft_status: "pending" },
      current_task: { conversation_id: null },
    })
    renderPanel()
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.noDraft")).toBeTruthy())
    // draftStatus 已写入 → draftMeta 显示 id 占位 + pending
    expect(screen.getByText(/novel\.persona\.draftMeta/)).toBeTruthy()
  })

  it("未勾选任何人格：提示 pickOne", async () => {
    renderPanel({ draftId: "draft-1" })
    for (const label of ["挑剔者", "共情者", "魔鬼设师", "读者代表"]) {
      fireEvent.click(screen.getByRole("button", { name: label }))
    }
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.pickOne")).toBeTruthy())
    expect(mocks.runPersonaCritique).not.toHaveBeenCalled()
  })

  it("运行中：按钮禁用并显示 running 文案，完成后渲染结果（ok/error/skipped 全分支）", async () => {
    let resolveCritique!: (value: CritiqueResultLike) => void
    mocks.runPersonaCritique.mockReturnValue(
      new Promise<CritiqueResultLike>((resolve) => {
        resolveCritique = resolve
      }),
    )
    renderPanel({ draftId: "draft-1" })
    const runBtn = clickRun()
    // 挂起期间：running 文案 + 禁用
    expect(screen.getByText("novel.persona.running")).toBeTruthy()
    expect((runBtn as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveCritique({ ok: true, draftStatus: "ready", results: okResults })
    })
    await waitFor(() => expect(screen.getByText("novel.persona.results")).toBeTruthy())
    // 每个结果的标签（人格按钮上也有同名文案，故用 getAllByText）
    expect(screen.getAllByText("挑剔者").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("共情者").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("魔鬼设师").length).toBeGreaterThanOrEqual(2)
    // status 文案三分支
    expect(screen.getByText("novel.persona.statusOk")).toBeTruthy()
    expect(screen.getByText("novel.persona.statusError")).toBeTruthy()
    expect(screen.getByText("novel.persona.statusSkipped")).toBeTruthy()
    // summary / findings / error / writtenPath
    expect(screen.getByText("节奏略拖")).toBeTruthy()
    expect(screen.getByText("开头慢")).toBeTruthy()
    expect(screen.getByText("对话平")).toBeTruthy()
    expect(screen.getByText("llm boom")).toBeTruthy()
    expect(screen.getByText(/novel\.persona\.written/)).toBeTruthy()
    // 运行结束恢复
    expect(screen.queryByText("novel.persona.running")).toBeNull()
  })

  it("无 summary / findings / writtenPath 的结果不渲染对应块", async () => {
    mocks.runPersonaCritique.mockResolvedValue({
      ok: true,
      results: [{ personaId: "reader", label: "读者代表", status: "ok", updatedAt: "2026-01-01T00:00:00.000Z" }],
    })
    renderPanel({ draftId: "draft-1" })
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.results")).toBeTruthy())
    expect(screen.queryByText(/novel\.persona\.written/)).toBeNull()
  })

  it("draft-not-ready：reason 显示状态", async () => {
    mocks.runPersonaCritique.mockResolvedValue({
      ok: false,
      reason: "draft-not-ready",
      draftStatus: "pending",
      results: [],
    })
    renderPanel({ draftId: "draft-1" })
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.draftNotReady::pending")).toBeTruthy())
    expect(screen.getByText(/novel\.persona\.draftMeta/)).toBeTruthy()
  })

  it("draft-not-ready 无 draftStatus：回退 unknown", async () => {
    mocks.runPersonaCritique.mockResolvedValue({ ok: false, reason: "draft-not-ready", results: [] })
    renderPanel({ draftId: "draft-1" })
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.draftNotReady::unknown")).toBeTruthy())
  })

  it("draft-missing：reason 提示", async () => {
    mocks.runPersonaCritique.mockResolvedValue({ ok: false, reason: "draft-missing", results: [] })
    renderPanel({ draftId: "draft-1" })
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.draftMissing")).toBeTruthy())
  })

  it("empty-personas：reason 提示；res 无 draftStatus 时回退 statusDraft", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue({
      draft: { draft_id: "draft-1", draft_status: "ready" },
      current_task: { conversation_id: "conv-1" },
    })
    mocks.runPersonaCritique.mockResolvedValue({ ok: false, reason: "empty-personas", results: [] })
    renderPanel()
    clickRun()
    await waitFor(() => expect(screen.getByText("novel.persona.emptyPersonas")).toBeTruthy())
    // res.draftStatus undefined → statusDraft("ready") 回退
    expect(screen.getByText(/novel\.persona\.draftMeta/)).toBeTruthy()
  })

  it("runPersonaCritique 抛出 Error：catch 透传 message", async () => {
    mocks.runPersonaCritique.mockRejectedValue(new Error("critique boom"))
    renderPanel({ draftId: "draft-1" })
    clickRun()
    await waitFor(() => expect(screen.getByText("critique boom")).toBeTruthy())
  })

  it("runPersonaCritique 抛出非 Error：String(err) 兜底", async () => {
    mocks.runPersonaCritique.mockRejectedValue("raw-boom")
    renderPanel({ draftId: "draft-1" })
    clickRun()
    await waitFor(() => expect(screen.getByText("raw-boom")).toBeTruthy())
  })
})
