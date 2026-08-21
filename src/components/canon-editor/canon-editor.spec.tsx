// @vitest-environment jsdom
//
// Canon 编辑前端（只读版）spec —— T18a / F-01。
//
// 覆盖：
//   1. 渲染：canon_query_batch 调用 → 事实表渲染 + max_revision 展示；
//   2. 过滤：known_by / valid_at_chapter / edge_kinds 下推到 IPC；
//   3. max_revision 展示（正常值 / 加载中 / 错误）；
//   4. 状态：loading / error / empty；
//   5. 边界：批量结果缺首项时的降级（results[0] ?? []）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { CanonEditor } from "./canon-editor"
import type { CanonEdge, CanonQueryBatchResponse } from "./canon-types"

// ── invoke mock（canon-editor-client 唯一 IPC 缝合点）──────────────
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

// ── fixtures ──────────────────────────────────────────────────────
const PROJECT_ID = "proj-1"

function makeEdge(overrides: Partial<CanonEdge> = {}): CanonEdge {
  return {
    id: "e1",
    source_id: "ent:alice",
    target_id: "ent:bob",
    predicate: "KNOWS",
    edge_kind: "world_fact",
    valid_at: 1,
    invalid_at: null,
    known_by: ["pov:alpha"],
    revealed_at: 1,
    confidence: 0.9,
    source_chapter: 1,
    digest: "abcdef0123456789",
    ...overrides,
  }
}

const SAMPLE_EDGES: CanonEdge[] = [
  makeEdge({
    id: "e1",
    source_id: "ent:alice",
    target_id: "ent:bob",
    predicate: "KNOWS",
    edge_kind: "motivation",
    valid_at: 3,
    invalid_at: null,
    known_by: ["pov:alpha"],
    revealed_at: 3,
    confidence: 0.8,
    source_chapter: 3,
    digest: "aaaa1111bbbb2222",
  }),
  makeEdge({
    id: "e2",
    source_id: "ent:bob",
    target_id: "ent:castle",
    predicate: "BESIEGES",
    edge_kind: "foreshadow",
    valid_at: 5,
    invalid_at: 12,
    known_by: ["pov:alpha", "pov:beta"],
    revealed_at: 6,
    confidence: null,
    source_chapter: 5,
    digest: "cccc3333",
  }),
]

/** 所有 optional 字段为 undefined 的最小边（覆盖 format* 的缺省分支）。 */
const SPARSE_EDGE: CanonEdge = {
  id: "e3",
  source_id: "ent:x",
  target_id: "ent:y",
  predicate: "RELATED_TO",
  edge_kind: "attribute",
  valid_at: undefined,
  invalid_at: undefined,
  reference_time: undefined,
  known_by: undefined,
  revealed_at: undefined,
  confidence: undefined,
  source_chapter: undefined,
  digest: undefined,
}

function batchResponse(
  edges: CanonEdge[],
  maxRevision: number,
): CanonQueryBatchResponse {
  return { results: [edges], max_revision: maxRevision }
}

function lastInvokeArgs(): { projectId: string; filters: unknown[] } {
  const call = invokeMock.mock.calls[invokeMock.mock.calls.length - 1]
  return call[1] as { projectId: string; filters: unknown[] }
}

async function renderLoaded(
  response: CanonQueryBatchResponse = batchResponse(SAMPLE_EDGES, 7),
): Promise<void> {
  invokeMock.mockResolvedValueOnce(response)
  render(<CanonEditor projectId={PROJECT_ID} />)
  await waitFor(() => {
    expect(screen.getByTestId("canon-max-revision-value").textContent).toBe(
      String(response.max_revision),
    )
  })
}

afterEach(() => {
  cleanup()
})

describe("CanonEditor — 渲染与 max_revision 展示", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDomGlobals()
  })

  it("挂载即调用 canon_query_batch(projectId, [{}]) 并渲染事实表", async () => {
    await renderLoaded()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][0]).toBe("canon_query_batch")
    const args = invokeMock.mock.calls[0][1] as { projectId: string; filters: unknown[] }
    expect(args.projectId).toBe(PROJECT_ID)
    // 初始过滤为空对象（不过滤任何维 → 返回全部边）
    expect(args.filters).toEqual([{}])

    // 两条边均渲染
    expect(screen.getByTestId("canon-fact-row-e1")).toBeTruthy()
    expect(screen.getByTestId("canon-fact-row-e2")).toBeTruthy()
    // source → target
    expect(screen.getByTestId("canon-fact-source-e1").textContent).toBe("ent:alice")
    expect(screen.getByTestId("canon-fact-target-e1").textContent).toBe("ent:bob")
  })

  it("max_revision 正常展示（表头徽标）", async () => {
    await renderLoaded(batchResponse(SAMPLE_EDGES, 42))
    expect(screen.getByTestId("canon-max-revision-value").textContent).toBe("42")
  })

  it("edge_kind 用中文标签展示", async () => {
    await renderLoaded()
    // e1=motivation→动机，e2=foreshadow→伏笔
    const row1 = screen.getByTestId("canon-fact-row-e1")
    const row2 = screen.getByTestId("canon-fact-row-e2")
    expect(row1.textContent).toContain("动机")
    expect(row2.textContent).toContain("伏笔")
  })

  it("digest 截断展示（前 8 字符 + …），完整值在 title", async () => {
    await renderLoaded()
    const row1 = screen.getByTestId("canon-fact-row-e1")
    // digest 单元格是最后一列；截断后含省略号
    expect(row1.textContent).toContain("aaaa1111…")
    // title 保留完整 digest
    const titles = row1.querySelectorAll("[title]")
    expect(
      [...titles].some((el) => el.getAttribute("title") === "aaaa1111bbbb2222"),
    ).toBe(true)
  })

  it("空边集渲染占位行", async () => {
    await renderLoaded(batchResponse([], 0))
    expect(screen.getByTestId("canon-fact-table-empty")).toBeTruthy()
    expect(screen.getByText("当前过滤下暂无事实边。")).toBeTruthy()
  })

  it("批量结果首项缺失时降级为空（results[0] ?? []）", async () => {
    invokeMock.mockResolvedValueOnce({ results: [], max_revision: 3 })
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId("canon-fact-table-empty")).toBeTruthy()
    })
    expect(screen.getByTestId("canon-max-revision-value").textContent).toBe("3")
  })
})

describe("CanonEditor — known_by / valid_at_chapter / edge_kinds 过滤下推", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDomGlobals()
  })

  it("known_by 输入下推到 filter（snake_case 字段）", async () => {
    invokeMock.mockResolvedValue(batchResponse([makeEdge({ id: "e1" })], 2))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-filter-known-by"), {
      target: { value: "pov:alpha" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    const args = lastInvokeArgs()
    expect(args.projectId).toBe(PROJECT_ID)
    expect(args.filters).toEqual([{ known_by: "pov:alpha" }])
  })

  it("valid_at_chapter 数字下推；非法输入忽略", async () => {
    invokeMock.mockResolvedValue(batchResponse([], 2))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-filter-valid-at-chapter"), {
      target: { value: "5" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    expect(lastInvokeArgs().filters).toEqual([{ valid_at_chapter: 5 }])

    // 非法输入（空 / 非数字）→ 不带该字段
    fireEvent.change(screen.getByTestId("canon-filter-valid-at-chapter"), {
      target: { value: "abc" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3))
    expect(lastInvokeArgs().filters).toEqual([{}])
  })

  it("edge_kind 选择下推为 edge_kinds 数组", async () => {
    invokeMock.mockResolvedValue(batchResponse([], 2))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-filter-edge-kind"), {
      target: { value: "foreshadow" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    expect(lastInvokeArgs().filters).toEqual([{ edge_kinds: ["foreshadow"] }])
  })

  it("组合过滤下推（known_by + valid_at_chapter + edge_kinds）", async () => {
    invokeMock.mockResolvedValue(batchResponse([], 4))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-filter-known-by"), {
      target: { value: "pov:beta" },
    })
    fireEvent.change(screen.getByTestId("canon-filter-valid-at-chapter"), {
      target: { value: "10" },
    })
    fireEvent.change(screen.getByTestId("canon-filter-edge-kind"), {
      target: { value: "arc" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    expect(lastInvokeArgs().filters).toEqual([
      {
        known_by: "pov:beta",
        valid_at_chapter: 10,
        edge_kinds: ["arc"],
      },
    ])
  })

  it("重置清空输入并回退到空过滤", async () => {
    invokeMock.mockResolvedValue(batchResponse([], 4))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId("canon-filter-known-by"), {
      target: { value: "pov:beta" },
    })
    fireEvent.change(screen.getByTestId("canon-filter-edge-kind"), {
      target: { value: "arc" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-reset"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    expect(lastInvokeArgs().filters).toEqual([{}])
    expect((screen.getByTestId("canon-filter-known-by") as HTMLInputElement).value).toBe("")
    expect((screen.getByTestId("canon-filter-edge-kind") as HTMLSelectElement).value).toBe("all")
  })

  it("过滤未变化时「应用过滤」禁用", async () => {
    invokeMock.mockResolvedValue(batchResponse([], 1))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    expect((screen.getByTestId("canon-filter-apply") as HTMLButtonElement).disabled).toBe(true)
    // 改动后启用
    fireEvent.change(screen.getByTestId("canon-filter-known-by"), {
      target: { value: "x" },
    })
    expect((screen.getByTestId("canon-filter-apply") as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("CanonEditor — loading / error / 刷新", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDomGlobals()
  })

  it("加载中显示 loading 态", async () => {
    let resolveLoad!: (value: CanonQueryBatchResponse) => void
    invokeMock.mockReturnValue(
      new Promise<CanonQueryBatchResponse>((resolve) => {
        resolveLoad = resolve
      }),
    )
    render(<CanonEditor projectId={PROJECT_ID} />)
    expect(screen.getByTestId("canon-editor-loading")).toBeTruthy()
    // max_revision 未就绪时展示 —
    expect(screen.getByTestId("canon-max-revision-value").textContent).toBe("—")
    await act(async () => {
      resolveLoad(batchResponse(SAMPLE_EDGES, 9))
    })
    await waitFor(() => {
      expect(screen.queryByTestId("canon-editor-loading")).toBeNull()
      expect(screen.getByTestId("canon-max-revision-value").textContent).toBe("9")
    })
  })

  it("Error 实例抛出 → 显示错误信息，清空 max_revision", async () => {
    invokeMock.mockRejectedValueOnce(new Error("canon store 未初始化"))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId("canon-editor-error").textContent).toContain(
        "canon store 未初始化",
      )
    })
    expect(screen.getByTestId("canon-max-revision-value").textContent).toBe("—")
    expect(screen.queryByTestId("canon-fact-row-e1")).toBeNull()
  })

  it("非 Error 抛出 → 兜底文案", async () => {
    invokeMock.mockRejectedValueOnce("plain-string-failure")
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId("canon-editor-error").textContent).toContain(
        "canon_query_batch 调用失败",
      )
    })
  })

  it("刷新按钮重新调用 canon_query_batch（沿用当前已应用过滤）", async () => {
    invokeMock.mockResolvedValueOnce(batchResponse([], 1))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    // 应用一个过滤
    invokeMock.mockResolvedValueOnce(batchResponse([makeEdge({ id: "e1" })], 2))
    fireEvent.change(screen.getByTestId("canon-filter-known-by"), {
      target: { value: "pov:alpha" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    expect(lastInvokeArgs().filters).toEqual([{ known_by: "pov:alpha" }])

    // 刷新 → 沿用 same filter
    invokeMock.mockResolvedValueOnce(batchResponse([makeEdge({ id: "e1" })], 3))
    fireEvent.click(screen.getByTestId("canon-refresh"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3))
    expect(lastInvokeArgs().filters).toEqual([{ known_by: "pov:alpha" }])
    await waitFor(() => {
      expect(screen.getByTestId("canon-max-revision-value").textContent).toBe("3")
    })
  })

  it("projectId 变化触发重新查询", async () => {
    invokeMock.mockResolvedValueOnce(batchResponse([], 1))
    const { rerender } = render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    invokeMock.mockResolvedValueOnce(batchResponse([], 2))
    rerender(<CanonEditor projectId="proj-2" />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    expect(lastInvokeArgs().projectId).toBe("proj-2")
  })
})

describe("CanonFactTable — known_by 多 POV 与缺省字段格式化", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDomGlobals()
  })

  it("known_by 多 POV 用逗号连接；空数组 / 缺省展示 —", async () => {
    await renderLoaded(batchResponse(SAMPLE_EDGES, 1))
    expect(screen.getByTestId("canon-fact-known-by-e1").textContent).toBe("pov:alpha")
    expect(screen.getByTestId("canon-fact-known-by-e2").textContent).toBe(
      "pov:alpha, pov:beta",
    )
  })

  it("invalid_at=None 展示 —；confidence 缺省展示 —", async () => {
    await renderLoaded(batchResponse(SAMPLE_EDGES, 1))
    // e1.invalid_at = null → —；e1.valid_at = 3
    expect(screen.getByTestId("canon-fact-valid-at-e1").textContent).toBe("3")
    expect(screen.getByTestId("canon-fact-invalid-at-e1").textContent).toBe("—")
    // e2.confidence = null → —；e2.invalid_at = 12 → "12"
    expect(screen.getByTestId("canon-fact-confidence-e2").textContent).toBe("—")
    expect(screen.getByTestId("canon-fact-invalid-at-e2").textContent).toBe("12")
    // e1.confidence = 0.8 → "0.80"（两位小数）
    expect(screen.getByTestId("canon-fact-confidence-e1").textContent).toBe("0.80")
  })

  it("所有 optional 字段 undefined 时全部展示 —（缺省分支）", async () => {
    await renderLoaded(batchResponse([SPARSE_EDGE], 1))
    expect(screen.getByTestId("canon-fact-valid-at-e3").textContent).toBe("—")
    expect(screen.getByTestId("canon-fact-invalid-at-e3").textContent).toBe("—")
    expect(screen.getByTestId("canon-fact-confidence-e3").textContent).toBe("—")
    expect(screen.getByTestId("canon-fact-known-by-e3").textContent).toBe("—")
    // digest undefined → —（短摘要走 else 分支）
    const row = screen.getByTestId("canon-fact-row-e3")
    expect(row.textContent).toContain("—")
  })

  it("未知 edge_kind 回退展示原始字符串（标签兜底分支）", async () => {
    const unknownEdge = { ...SPARSE_EDGE, id: "e9", edge_kind: "unknown_kind" as CanonEdge["edge_kind"] }
    await renderLoaded(batchResponse([unknownEdge], 1))
    expect(screen.getByTestId("canon-fact-row-e9").textContent).toContain("unknown_kind")
  })
})
