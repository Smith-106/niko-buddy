// @vitest-environment jsdom
//
// CanonFactsKnownByPanel spec —— P1-1（15-p1-1 §3.1）。
//
// 覆盖：
//   1. 未选 POV → 不调用 IPC，展示「请先选择 POV」空态；
//   2. 选 POV → 调 getFactsKnownByPaged 并渲染事实行（projectEdge 投影产物）；
//   3. 章节截点变化 / includeInvalidated 切换 → 自动重查（带新参数）；
//   4. 有 POV 无事实 → 空态；
//   5. 服务端分页（total 驱动 pageCount）+ prev/next；
//   6. 错误态（Error / 非 Error 兜底）；
//   7. refreshSignal 变化重查；
//   8. DOM 不含 known_by / digest 字面量（POV 防泄密）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { CanonFactsKnownByPanel } from "./canon-facts-known-by-panel"
import type { CanonFact } from "@/lib/novel/canon-graph-client"

// ── module mocks ──────────────────────────────────────────────────
const getFactsKnownByPagedMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/novel/canon-graph-client", () => ({
  getFactsKnownByPaged: getFactsKnownByPagedMock,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}))

// ── fixtures ──────────────────────────────────────────────────────
const PROJECT_ID = "proj-1"
const ALLOWLIST = ["pov:alpha", "pov:beta"]

function makeFact(overrides: Partial<CanonFact> = {}): CanonFact {
  return {
    id: "f1",
    sourceId: "ent:alice",
    targetId: "ent:bob",
    predicate: "KNOWS",
    edgeKind: "world_fact",
    validAt: 1,
    invalidAt: null,
    archived: false,
    recordedRevision: 1,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  getFactsKnownByPagedMock.mockReset()
  setupDomGlobals()
})

describe("CanonFactsKnownByPanel — POV 选择与三态", () => {
  it("未选 POV 时不调用 IPC，展示「请先选择 POV」空态", () => {
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    expect(screen.getByTestId("canon-facts-empty-no-pov")).toBeInTheDocument()
    expect(getFactsKnownByPagedMock).not.toHaveBeenCalled()
  })

  it("选 POV 后调用 getFactsKnownByPaged 并渲染事实行（投影产物）", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({
      facts: [makeFact()],
      total: 1,
      maxRevision: 7,
    })
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalled())
    expect(getFactsKnownByPagedMock).toHaveBeenLastCalledWith(
      PROJECT_ID,
      "pov:alpha",
      undefined,
      false,
      { offset: 0, limit: 200 },
    )
    expect(await screen.findByTestId("canon-facts-row-f1")).toBeInTheDocument()
    expect(screen.getByTestId("canon-facts-row-f1").textContent).toContain("KNOWS")
    expect(screen.getByTestId("canon-facts-row-f1").textContent).toContain(
      "ent:alice → ent:bob",
    )
  })

  it("有 POV 但无事实 → 空态", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({ facts: [], total: 0, maxRevision: 7 })
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    expect(await screen.findByTestId("canon-facts-empty")).toBeInTheDocument()
  })

  it("Error 实例拒绝 → 错误态", async () => {
    getFactsKnownByPagedMock.mockRejectedValueOnce(new Error("store boom"))
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    expect(await screen.findByTestId("canon-facts-error")).toHaveTextContent("store boom")
  })

  it("非 Error 拒绝 → 兜底文案", async () => {
    getFactsKnownByPagedMock.mockRejectedValueOnce("plain")
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    expect(await screen.findByTestId("canon-facts-error")).toHaveTextContent(
      "canon_facts_known_by 调用失败",
    )
  })
})

describe("CanonFactsKnownByPanel — 章节截点 / includeInvalidated 自动重查", () => {
  it("章节输入有效值变化 → 以新 atChapter 重查", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({ facts: [makeFact()], total: 1, maxRevision: 1 })
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-facts-chapter"), {
      target: { value: "10" },
    })
    await waitFor(() =>
      expect(getFactsKnownByPagedMock).toHaveBeenLastCalledWith(
        PROJECT_ID,
        "pov:alpha",
        10,
        false,
        { offset: 0, limit: 200 },
      ),
    )
  })

  it("章节输入清空 → 回退 atChapter undefined", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({ facts: [makeFact()], total: 1, maxRevision: 1 })
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-facts-chapter"), {
      target: { value: "" },
    })
    await waitFor(() =>
      expect(getFactsKnownByPagedMock).toHaveBeenLastCalledWith(
        PROJECT_ID,
        "pov:alpha",
        undefined,
        false,
        { offset: 0, limit: 200 },
      ),
    )
  })

  it("includeInvalidated 勾选 → 以 includeInvalidated=true 重查", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({ facts: [makeFact()], total: 1, maxRevision: 1 })
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId("canon-facts-include-invalidated"))
    await waitFor(() =>
      expect(getFactsKnownByPagedMock).toHaveBeenLastCalledWith(
        PROJECT_ID,
        "pov:alpha",
        undefined,
        true,
        { offset: 0, limit: 200 },
      ),
    )
  })

  it("POV 切换 → 重置到第 1 页并重查", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({ facts: [makeFact()], total: 1, maxRevision: 1 })
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:beta" },
    })
    await waitFor(() =>
      expect(getFactsKnownByPagedMock).toHaveBeenLastCalledWith(
        PROJECT_ID,
        "pov:beta",
        undefined,
        false,
        { offset: 0, limit: 200 },
      ),
    )
  })
})

describe("CanonFactsKnownByPanel — 服务端分页 + refreshSignal", () => {
  it("total 超过单页时渲染分页并支持 next（offset 递增）", async () => {
    getFactsKnownByPagedMock
      .mockResolvedValueOnce({ facts: [makeFact({ id: "p1" })], total: 250, maxRevision: 7 })
      .mockResolvedValueOnce({ facts: [makeFact({ id: "p2" })], total: 250, maxRevision: 7 })
    render(<CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("canon-facts-pagination")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("canon-facts-page-next"))
    await waitFor(() =>
      expect(getFactsKnownByPagedMock).toHaveBeenLastCalledWith(
        PROJECT_ID,
        "pov:alpha",
        undefined,
        false,
        { offset: 200, limit: 200 },
      ),
    )
    expect(await screen.findByTestId("canon-facts-row-p2")).toBeInTheDocument()
  })

  it("refreshSignal 变化 → 重查", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({ facts: [makeFact()], total: 1, maxRevision: 7 })
    const { rerender } = render(
      <CanonFactsKnownByPanel
        projectId={PROJECT_ID}
        povAllowlist={ALLOWLIST}
        refreshSignal={0}
      />,
    )
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalledTimes(1))

    rerender(
      <CanonFactsKnownByPanel
        projectId={PROJECT_ID}
        povAllowlist={ALLOWLIST}
        refreshSignal={1}
      />,
    )
    await waitFor(() => expect(getFactsKnownByPagedMock).toHaveBeenCalledTimes(2))
  })
})

describe("CanonFactsKnownByPanel — POV 防泄密（不泄漏内部句柄）", () => {
  it("渲染的 DOM 不含 known_by / digest 字面量", async () => {
    getFactsKnownByPagedMock.mockResolvedValue({
      facts: [makeFact({ predicate: "KNOWS", recordedRevision: 3 })],
      total: 1,
      maxRevision: 7,
    })
    const { container } = render(
      <CanonFactsKnownByPanel projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />,
    )
    fireEvent.change(screen.getByTestId("canon-facts-pov"), {
      target: { value: "pov:alpha" },
    })
    await waitFor(() => expect(screen.getByTestId("canon-facts-row-f1")).toBeInTheDocument())
    expect(container.textContent).not.toContain("known_by")
    expect(container.textContent).not.toContain("digest")
  })
})
