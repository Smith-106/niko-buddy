// @vitest-environment jsdom
//
// CanonRevisionDiffView spec —— 跨 revision 对比结果纯展示（P2）。
//
// 覆盖：摘要徽标 / 取代配对（before → after）/ 新增列表 / 空态 /
// invalidated·removed 空时隐藏分区。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { CanonRevisionDiffView } from "./canon-revision-diff-view"
import type { CanonFact } from "@/lib/novel/canon-graph-client"
import type { CanonRevisionDiff } from "@/lib/novel/canon-revision-diff"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}))

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

function makeDiff(overrides: Partial<CanonRevisionDiff> = {}): CanonRevisionDiff {
  return {
    revA: null,
    revB: 2,
    added: [],
    superseded: [],
    invalidated: [],
    removed: [],
    changes: [],
    total: 0,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
})

describe("CanonRevisionDiffView — 摘要 / 空态", () => {
  it("渲染摘要徽标（新增/取代计数）", () => {
    const diff = makeDiff({
      added: [makeFact({ id: "a" })],
      superseded: [
        {
          kind: "superseded",
          before: makeFact({ id: "old", invalidAt: 5 }),
          after: makeFact({ id: "new", invalidAt: null }),
        },
      ],
      total: 2,
    })
    render(<CanonRevisionDiffView diff={diff} revA={null} revB={2} />)
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("canon.revisionDiff.summary")
  })

  it("空 diff → 空态", () => {
    render(<CanonRevisionDiffView diff={makeDiff()} revA={null} revB={2} />)
    expect(screen.getByTestId("diff-empty")).toBeInTheDocument()
  })
})

describe("CanonRevisionDiffView — 分区渲染", () => {
  it("新增分区渲染每条边", () => {
    const diff = makeDiff({
      added: [
        makeFact({ id: "a", predicate: "KNOWS" }),
        makeFact({ id: "b", predicate: "LOVES" }),
      ],
      total: 2,
    })
    render(<CanonRevisionDiffView diff={diff} revA={1} revB={2} />)
    expect(screen.getByTestId("diff-added-section")).toBeInTheDocument()
    expect(screen.getAllByTestId("diff-added-item")).toHaveLength(2)
  })

  it("取代分区渲染 before → after 配对", () => {
    const diff = makeDiff({
      superseded: [
        {
          kind: "superseded",
          before: makeFact({ id: "old", invalidAt: 5 }),
          after: makeFact({ id: "new", invalidAt: null }),
        },
      ],
      total: 1,
    })
    render(<CanonRevisionDiffView diff={diff} revA={1} revB={2} />)
    const section = screen.getByTestId("diff-superseded-section")
    expect(section).toBeInTheDocument()
    expect(screen.getByTestId("diff-superseded-item")).toHaveTextContent("KNOWS")
    // pairArrow 文本（t 返回原始 key）
    expect(screen.getByTestId("diff-superseded-item")).toHaveTextContent(
      "canon.revisionDiff.pairArrow",
    )
  })

  it("invalidated/removed 空时隐藏分区", () => {
    const diff = makeDiff({ added: [makeFact({ id: "a" })], total: 1 })
    render(<CanonRevisionDiffView diff={diff} revA={1} revB={2} />)
    expect(screen.queryByTestId("diff-invalidated-section")).not.toBeInTheDocument()
    expect(screen.queryByTestId("diff-removed-section")).not.toBeInTheDocument()
  })

  it("不渲染内部句柄 knownBy/digest（防泄密对齐）", () => {
    const diff = makeDiff({ added: [makeFact({ id: "a" })], total: 1 })
    const { container } = render(<CanonRevisionDiffView diff={diff} revA={1} revB={2} />)
    expect(container.textContent).not.toMatch(/\bknown_by\b/)
    expect(container.textContent).not.toMatch(/\bdigest\b/)
  })
})
