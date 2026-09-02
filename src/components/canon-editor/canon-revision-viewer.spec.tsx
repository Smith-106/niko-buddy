// @vitest-environment jsdom
//
// CanonRevisionViewer spec —— P1-1（15-p1-1 §3.2）。
//
// 覆盖：
//   1. revision 徽标值（getCanonRevision）；
//   2. 按 recorded_revision 倒序分组时间线（null → 旧数据组）；
//   3. 空态 / 错误态；
//   4. 手动刷新 + refreshSignal 重查；
//   5. groupByRecordedRevision 纯函数（倒序 + null 末位）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { CanonRevisionViewer, groupByRecordedRevision } from "./canon-revision-viewer"
import type { CanonFact } from "@/lib/novel/canon-graph-client"

// ── module mocks ──────────────────────────────────────────────────
const getCanonRevisionMock = vi.hoisted(() => vi.fn())
const queryCanonEdgesMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/novel/canon-dual-write", () => ({
  getCanonRevision: getCanonRevisionMock,
}))

vi.mock("@/lib/novel/canon-graph-client", () => ({
  queryCanonEdges: queryCanonEdgesMock,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}))

// ── fixtures ──────────────────────────────────────────────────────
const PROJECT_ID = "proj-1"

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
  getCanonRevisionMock.mockReset()
  queryCanonEdgesMock.mockReset()
  setupDomGlobals()
})

describe("groupByRecordedRevision (pure)", () => {
  it("数值倒序，null（旧数据无戳）组排最后", () => {
    const groups = groupByRecordedRevision([
      makeFact({ id: "a", recordedRevision: 1 }),
      makeFact({ id: "b", recordedRevision: 3 }),
      makeFact({ id: "c", recordedRevision: null }),
      makeFact({ id: "d", recordedRevision: 3 }),
    ])
    expect(groups.map((g) => g.revision)).toEqual([3, 1, null])
    expect(groups[0]!.facts.map((f) => f.id).sort()).toEqual(["b", "d"])
    expect(groups[2]!.facts.map((f) => f.id)).toEqual(["c"])
  })
})

describe("CanonRevisionViewer — 徽标与时间线分组", () => {
  it("渲染 revision 徽标值（getCanonRevision）", async () => {
    getCanonRevisionMock.mockResolvedValue(7)
    queryCanonEdgesMock.mockResolvedValue([makeFact()])
    render(<CanonRevisionViewer projectId={PROJECT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId("revision-badge-value").textContent).toBe("7")
    })
  })

  it("按 recorded_revision 倒序分组；null 归旧数据组", async () => {
    getCanonRevisionMock.mockResolvedValue(3)
    queryCanonEdgesMock.mockResolvedValue([
      makeFact({ id: "a", recordedRevision: 1 }),
      makeFact({ id: "b", recordedRevision: 3 }),
      makeFact({ id: "c", recordedRevision: null }),
    ])
    const { container } = render(<CanonRevisionViewer projectId={PROJECT_ID} />)
    await waitFor(() => expect(screen.getByTestId("revision-group-3")).toBeInTheDocument())

    const groups = [...container.querySelectorAll('[data-testid^="revision-group"]')]
    expect(groups.map((g) => g.getAttribute("data-testid"))).toEqual([
      "revision-group-3",
      "revision-group-1",
      "revision-group-legacy",
    ])
    expect(screen.getByTestId("revision-group-legacy")).toBeInTheDocument()
  })
})

describe("CanonRevisionViewer — 空态 / 错误态 / 刷新", () => {
  it("无边时展示空态", async () => {
    getCanonRevisionMock.mockResolvedValue(0)
    queryCanonEdgesMock.mockResolvedValue([])
    render(<CanonRevisionViewer projectId={PROJECT_ID} />)
    expect(await screen.findByTestId("revision-empty")).toBeInTheDocument()
  })

  it("queryCanonEdges 拒绝 → 错误态", async () => {
    getCanonRevisionMock.mockResolvedValue(0)
    queryCanonEdgesMock.mockRejectedValueOnce(new Error("query boom"))
    render(<CanonRevisionViewer projectId={PROJECT_ID} />)
    expect(await screen.findByTestId("revision-error")).toHaveTextContent("query boom")
  })

  it("非 Error 拒绝 → 兜底文案", async () => {
    getCanonRevisionMock.mockResolvedValue(0)
    queryCanonEdgesMock.mockRejectedValueOnce("plain")
    render(<CanonRevisionViewer projectId={PROJECT_ID} />)
    expect(await screen.findByTestId("revision-error")).toHaveTextContent(
      "canon 修订历史加载失败",
    )
  })

  it("手动刷新按钮重新拉取", async () => {
    getCanonRevisionMock.mockResolvedValue(0)
    queryCanonEdgesMock.mockResolvedValue([])
    render(<CanonRevisionViewer projectId={PROJECT_ID} />)
    await waitFor(() => expect(queryCanonEdgesMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId("revision-refresh"))
    await waitFor(() => expect(queryCanonEdgesMock).toHaveBeenCalledTimes(2))
  })

  it("refreshSignal 变化 → 重查", async () => {
    getCanonRevisionMock.mockResolvedValue(0)
    queryCanonEdgesMock.mockResolvedValue([])
    const { rerender } = render(<CanonRevisionViewer projectId={PROJECT_ID} refreshSignal={0} />)
    await waitFor(() => expect(queryCanonEdgesMock).toHaveBeenCalledTimes(1))

    rerender(<CanonRevisionViewer projectId={PROJECT_ID} refreshSignal={1} />)
    await waitFor(() => expect(queryCanonEdgesMock).toHaveBeenCalledTimes(2))
  })
})
