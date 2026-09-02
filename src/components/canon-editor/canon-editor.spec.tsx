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
import type { RawCanonEdge } from "@/lib/novel/canon-graph-client"
import {
  buildSupersedeRequestForCorrection,
  computeCorrectionDigest,
  makeCorrectionId,
  validateKnownByCorrection,
  validateRevealedAtCorrection,
} from "./canon-editor"

// ── invoke mock（canon-editor-client 唯一 IPC 缝合点）──────────────
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

// 合并后 CanonEditor 浏览模式渲染两个 P1-1 面板（facts/revision），它们各自经
// @/lib/novel/* 投影封装取数；此处 mock 掉使面板不触达真实 invoke，保留
// canon-editor 自身 IPC 缝合点（canon_query_batch / canon_supersede_edges）的
// invokeMock 断言不受干扰。buildCanonEdgeFilter 保留真实实现（v2.8 P1-2：
// buildFilter 委托共享构造器，骨架产物形状由真实构造器保证）。
vi.mock("@/lib/novel/canon-graph-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/canon-graph-client")>()
  return {
    ...actual,
    getFactsKnownByPaged: vi.fn().mockResolvedValue({ facts: [], total: 0, maxRevision: 0 }),
    queryCanonEdges: vi.fn().mockResolvedValue([]),
  }
})

vi.mock("@/lib/novel/canon-dual-write", () => ({
  getCanonRevision: vi.fn().mockResolvedValue(0),
}))

// i18next v26 use() 校验 module.type 必须存在，否则抛 "wrong module"（spec 环境修复）。
// t 为 identity：面板文案渲染 key 字符串，既有中文硬编码断言不受影响；
// tSpy 暴露插值参数断言（v2.8 P1-2：分页器 total/pageCount 断言用）。
const tSpy = vi.hoisted(() => vi.fn((key: string) => key))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tSpy }),
  initReactI18next: { type: "3rdParty", init: () => {} },
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
  total = edges.length,
): CanonQueryBatchResponse {
  // v2.8 P1-2：响应含 totals（与 results 下标对齐的过滤后全量计数）
  return { results: [edges], totals: [total], max_revision: maxRevision }
}

/** 生成 n 条可区分边（服务端分页用例造 100+ 条数据）。 */
function makeEdgeRange(n: number, idPrefix = "p"): CanonEdge[] {
  return Array.from({ length: n }, (_, i) =>
    makeEdge({ id: `${idPrefix}${i}`, predicate: "KNOWS" }),
  )
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
  tSpy.mockClear()
})

describe("CanonEditor — 渲染与 max_revision 展示", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDomGlobals()
  })

  it("挂载即调用 canon_query_batch（首页 offset/limit + 空过滤）并渲染事实表", async () => {
    await renderLoaded()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][0]).toBe("canon_query_batch")
    const args = invokeMock.mock.calls[0][1] as { projectId: string; filters: unknown[] }
    expect(args.projectId).toBe(PROJECT_ID)
    // v2.8 P1-2 服务端分页：初始过滤 = buildCanonEdgeFilter(空输入)（全 null 字段，
    // 由真实构造器保证）+ 首页 offset/limit 注入
    expect(args.filters).toEqual([
      expect.objectContaining({ offset: 0, limit: 100 }),
    ])

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
    expect(args.filters).toEqual([
      expect.objectContaining({ known_by: "pov:alpha", offset: 0, limit: 100 }),
    ])
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
    expect(lastInvokeArgs().filters).toEqual([
      expect.objectContaining({ valid_at_chapter: 5, offset: 0, limit: 100 }),
    ])

    // 非法输入（空 / 非数字）→ 不带该字段
    fireEvent.change(screen.getByTestId("canon-filter-valid-at-chapter"), {
      target: { value: "abc" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3))
    expect(lastInvokeArgs().filters).toEqual([
      expect.objectContaining({ offset: 0, limit: 100 }),
    ])
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
    expect(lastInvokeArgs().filters).toEqual([
      expect.objectContaining({ edge_kinds: ["foreshadow"], offset: 0, limit: 100 }),
    ])
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
      expect.objectContaining({
        known_by: "pov:beta",
        valid_at_chapter: 10,
        edge_kinds: ["arc"],
        offset: 0,
        limit: 100,
      }),
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
    expect(lastInvokeArgs().filters).toEqual([
      expect.objectContaining({ offset: 0, limit: 100 }),
    ])
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
    expect(lastInvokeArgs().filters).toEqual([
      expect.objectContaining({ known_by: "pov:alpha", offset: 0, limit: 100 }),
    ])

    // 刷新 → 沿用 same filter
    invokeMock.mockResolvedValueOnce(batchResponse([makeEdge({ id: "e1" })], 3))
    fireEvent.click(screen.getByTestId("canon-refresh"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3))
    expect(lastInvokeArgs().filters).toEqual([
      expect.objectContaining({ known_by: "pov:alpha", offset: 0, limit: 100 }),
    ])
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

// ============================================================================
// v2.8 P1-2：服务端分页（offset/limit + total，PaginationControls）
// ============================================================================

describe("CanonEditor — 服务端分页（v2.8 P1-2）", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDomGlobals()
  })

  it("total=150（2 页）→ 分页器可见，翻页触发 offset=100 的二次 invoke", async () => {
    invokeMock.mockResolvedValueOnce(batchResponse(makeEdgeRange(100, "a"), 7, 150))
    invokeMock.mockResolvedValue(batchResponse(makeEdgeRange(50, "b"), 7, 150))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    expect(invokeMock.mock.calls[0]![1].filters[0]).toEqual(
      expect.objectContaining({ offset: 0, limit: 100 }),
    )
    await waitFor(() => expect(screen.getByTestId("canon-pagination")).toBeTruthy())
    // 分页器信息：t 以服务端 total / 推导 pageCount 插值（identity mock 渲染 key，参数走断言）
    expect(tSpy).toHaveBeenCalledWith(
      "common.pagination.info",
      expect.objectContaining({ page: 1, pageCount: 2, total: 150 }),
    )

    fireEvent.click(screen.getByTestId("canon-page-next"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    expect(invokeMock.mock.calls[1]![1].filters[0]).toEqual(
      expect.objectContaining({ offset: 100, limit: 100 }),
    )
  })

  it("首页 prev 禁用；末页 next 禁用", async () => {
    invokeMock.mockResolvedValueOnce(batchResponse(makeEdgeRange(100, "a"), 7, 150))
    invokeMock.mockResolvedValue(batchResponse(makeEdgeRange(50, "b"), 7, 150))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(screen.getByTestId("canon-pagination")).toBeTruthy())
    expect((screen.getByTestId("canon-page-prev") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("canon-page-next") as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId("canon-page-next"))
    await waitFor(() => {
      expect((screen.getByTestId("canon-page-next") as HTMLButtonElement).disabled).toBe(true)
    })
    expect((screen.getByTestId("canon-page-prev") as HTMLButtonElement).disabled).toBe(false)
  })

  it("page>1 空页 + total>0 → 越界回跳以 offset=0 自动重取", async () => {
    invokeMock.mockResolvedValueOnce(batchResponse(makeEdgeRange(100, "a"), 7, 150))
    invokeMock.mockResolvedValue(batchResponse([], 7, 150))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(screen.getByTestId("canon-pagination")).toBeTruthy())

    fireEvent.click(screen.getByTestId("canon-page-next"))
    // 第 2 页返回空页但 total=150 → 越界回跳守卫回第 1 页（第三次 invoke offset=0）
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3))
    expect(invokeMock.mock.calls[2]![1].filters[0]).toEqual(
      expect.objectContaining({ offset: 0, limit: 100 }),
    )
  })

  it("page>1 应用过滤 → 新过滤以 offset=0 下推（同步回页 1）", async () => {
    invokeMock.mockResolvedValueOnce(batchResponse(makeEdgeRange(100, "a"), 7, 150))
    invokeMock.mockResolvedValue(batchResponse(makeEdgeRange(50, "b"), 7, 150))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(screen.getByTestId("canon-pagination")).toBeTruthy())
    fireEvent.click(screen.getByTestId("canon-page-next"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))

    // 应用过滤：响应改为新过滤结果（total=30，仅 1 页）
    invokeMock.mockResolvedValue(batchResponse([], 7, 30))
    fireEvent.change(screen.getByTestId("canon-filter-known-by"), {
      target: { value: "pov:alpha" },
    })
    fireEvent.click(screen.getByTestId("canon-filter-apply"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3))
    expect(invokeMock.mock.calls[2]![1].filters[0]).toEqual(
      expect.objectContaining({ known_by: "pov:alpha", offset: 0, limit: 100 }),
    )
  })

  it("单页（total≤100）→ 分页器隐藏（hideOnSinglePage）", async () => {
    invokeMock.mockResolvedValue(batchResponse(SAMPLE_EDGES, 7, 2))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId("canon-fact-row-e1")).toBeTruthy()
    })
    expect(screen.queryByTestId("canon-pagination")).toBeNull()
  })

  it("挂载即非「假脏」：应用过滤按钮禁用（全 null 初始过滤与 buildFilter 同构）", async () => {
    invokeMock.mockResolvedValue(batchResponse([], 7, 0))
    render(<CanonEditor projectId={PROJECT_ID} />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    expect((screen.getByTestId("canon-filter-apply") as HTMLButtonElement).disabled).toBe(true)
  })

  it("校正模式翻页同样携带 offset/limit", async () => {
    const edges = Array.from({ length: 100 }, (_, i) =>
      makeCorrectionEdge({ id: `c${i}` }),
    )
    mockCorrectInvoke({ edges, total: 150 })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    const queryCalls = () =>
      invokeMock.mock.calls.filter((c) => c[0] === "canon_query_batch")
    await waitFor(() => expect(queryCalls().length).toBe(2))

    fireEvent.click(screen.getByTestId("canon-page-next"))
    await waitFor(() => expect(queryCalls().length).toBe(3))
    expect((queryCalls()[2]![1] as { filters: unknown[] }).filters[0]).toEqual(
      expect.objectContaining({ offset: 100, limit: 100 }),
    )
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

// ============================================================================
// 以下为合并自原 components/novel/canon-editor（校正写路径）的测试收口。
// 合并组件默认渲染浏览模式，校正相关用例先点「校正」进入校正模式。
// ============================================================================

const ALLOWLIST = ["pov:alpha", "pov:beta", "pov:gamma"]

function makeCorrectionEdge(overrides: Partial<RawCanonEdge> = {}): RawCanonEdge {
  return {
    id: "e1",
    source_id: "ent:alice",
    target_id: "ent:bob",
    predicate: "KNOWS",
    edge_kind: "motivation",
    valid_at: 3,
    invalid_at: null,
    reference_time: null,
    known_by: ["pov:alpha"],
    revealed_at: 4,
    confidence: 0.9,
    source_chapter: 3,
    digest: "aaaa1111",
    beat_label: null,
    beat_hit: null,
    foreshadow_planted_at: null,
    hook_type: null,
    payoff_chapter: null,
    archived: false,
    ...overrides,
  }
}

/** 让 canon_query_batch 返回给定边集；canon_supersede_edges 返回成功回执。 */
function mockCorrectInvoke(handlers: {
  edges?: RawCanonEdge[]
  maxRevision?: number
  /** 过滤后全量计数（v2.8 P1-2 服务端分页）；缺省 = edges.length */
  total?: number
  onSupersede?: () => Promise<unknown> | unknown
}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "canon_query_batch") {
      const edges = handlers.edges ?? []
      return {
        results: [edges],
        totals: [handlers.total ?? edges.length],
        max_revision: handlers.maxRevision ?? 7,
      }
    }
    if (cmd === "canon_supersede_edges") {
      if (handlers.onSupersede) return await handlers.onSupersede()
      return { result: { capped: 1, inserted: 1, missing: [] }, max_revision: 8 }
    }
    throw new Error(`unexpected command: ${cmd}`)
  })
}

/** 进入校正模式（合并组件默认渲染为浏览模式）。 */
async function enterCorrectMode() {
  fireEvent.click(await screen.findByTestId("canon-enter-correct"))
  await waitFor(() => expect(screen.getByTestId("canon-max-revision")).toBeInTheDocument())
}

// ── 纯函数：校正载荷 ───────────────────────────────────────────────

describe("correction payload builders (pure)", () => {
  it("makeCorrectionId prefixes corr: and embeds the salt", () => {
    expect(makeCorrectionId("e1", "abc")).toBe("corr:e1:abc")
    expect(makeCorrectionId("e1", "abc")).not.toBe("e1")
  })

  it("computeCorrectionDigest is deterministic and content-sensitive", () => {
    const a = computeCorrectionDigest("corr:e1:s|pov:alpha|5")
    const b = computeCorrectionDigest("corr:e1:s|pov:alpha|5")
    const c = computeCorrectionDigest("corr:e1:s|pov:beta|5")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })

  it("caps the old edge at its valid_at and patches only cognitive fields", () => {
    const old = makeCorrectionEdge({
      id: "e9",
      known_by: ["pov:alpha"],
      revealed_at: 4,
      beat_label: "fun_and_games",
      foreshadow_planted_at: 2,
      confidence: 0.7,
      source_chapter: 3,
    })
    const req = buildSupersedeRequestForCorrection(
      old,
      { knownBy: ["pov:beta"], revealedAt: 6 },
      "salt-1",
    )
    expect(req.old_edge_ids).toEqual(["e9"])
    expect(req.cap_chapter).toBe(3)
    expect(req.new_edges).toHaveLength(1)
    expect(req.caused_by).toBe("manual-correction")
    const next = req.new_edges[0]!
    expect(next.id).toBe(makeCorrectionId("e9", "salt-1"))
    expect(next.id).not.toBe(old.id)
    expect(next.known_by).toEqual(["pov:beta"])
    expect(next.revealed_at).toBe(6)
    expect(next.valid_at).toBe(3)
    expect(next.invalid_at).toBeNull()
    expect(next.predicate).toBe("KNOWS")
    expect(next.source_id).toBe("ent:alice")
    expect(next.target_id).toBe("ent:bob")
    expect(next.edge_kind).toBe("motivation")
    expect(next.beat_label).toBe("fun_and_games")
    expect(next.foreshadow_planted_at).toBe(2)
    expect(next.confidence).toBe(0.7)
    expect(next.source_chapter).toBe(3)
    expect(next.archived).toBe(false)
    expect(next.digest).toBeTruthy()
    expect(next.digest).not.toBe(old.digest)
  })

  it("caps at 0 when valid_at is absent and inherits an already-capped interval", () => {
    const dead = makeCorrectionEdge({ id: "d1", valid_at: null, invalid_at: 12 })
    const req = buildSupersedeRequestForCorrection(dead, { knownBy: [], revealedAt: null }, "s")
    expect(req.cap_chapter).toBe(0)
    expect(req.new_edges[0]!.invalid_at).toBe(12)
    expect(req.new_edges[0]!.revealed_at).toBeNull()
  })
})

// ── 纯函数：白名单与时态校验 ────────────────────────────────────────

describe("validators (pure)", () => {
  it("accepts allowlisted POVs and rejects blank entries", () => {
    expect(validateKnownByCorrection(["pov:alpha", "pov:beta"], ALLOWLIST).ok).toBe(true)
    const bad = validateKnownByCorrection(["  "], ALLOWLIST)
    expect(bad.ok).toBe(false)
    expect(bad.violations[0]!.code).toBe("empty_pov")
  })

  it("rejects non-allowlisted additions (fail-closed, incl. empty allowlist)", () => {
    const bad = validateKnownByCorrection(["pov:stranger"], ALLOWLIST)
    expect(bad.ok).toBe(false)
    expect(bad.violations[0]!.code).toBe("not_in_allowlist")

    const none = validateKnownByCorrection(["pov:alpha"], [])
    expect(none.ok).toBe(false)
    expect(none.violations[0]!.code).toBe("not_in_allowlist")

    expect(validateKnownByCorrection([], []).ok).toBe(true)
  })

  it("flags duplicate POVs after trimming", () => {
    const bad = validateKnownByCorrection(["pov:alpha", " pov:alpha "], ALLOWLIST)
    expect(bad.violations.some((v) => v.code === "duplicate_pov")).toBe(true)
  })

  it("revealed_at must be a positive integer chapter or null", () => {
    expect(validateRevealedAtCorrection(null, 3, 1).ok).toBe(true)
    expect(validateRevealedAtCorrection(5, 3, 2).ok).toBe(true)
    expect(validateRevealedAtCorrection(0, 3, 2).violations[0]!.code).toBe("invalid_revealed_at")
    expect(validateRevealedAtCorrection(-1, 3, 2).violations[0]!.code).toBe("invalid_revealed_at")
    expect(validateRevealedAtCorrection(Number.NaN, 3, 2).violations[0]!.code).toBe("invalid_revealed_at")
  })

  it("enforces revealed_at >= valid_at (Rust RevealedBeforeValid parity)", () => {
    const bad = validateRevealedAtCorrection(2, 3, 1)
    expect(bad.ok).toBe(false)
    expect(bad.violations[0]!.code).toBe("revealed_before_valid")
  })

  it("rejects a revelation with nobody knowing", () => {
    const bad = validateRevealedAtCorrection(5, 3, 0)
    expect(bad.ok).toBe(false)
    expect(bad.violations[0]!.code).toBe("revealed_without_known_by")
  })
})

// ── 校正模式 UI 可观测行为（合并收口）───────────────────────────────

describe("CanonEditor — 校正模式（写路径，合并收口）", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDomGlobals()
    mockCorrectInvoke({ edges: [makeCorrectionEdge()] })
  })

  it("进入校正模式后加载边并展示 revision", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("canon_query_batch", {
        projectId: PROJECT_ID,
        filters: [expect.objectContaining({ offset: 0, limit: 100 })],
      }),
    )
    await enterCorrectMode()
    expect(await screen.findByText("KNOWS")).toBeInTheDocument()
    expect(screen.getByTestId("canon-max-revision")).toHaveTextContent("7")
  })

  it("加载失败时展示错误并可经刷新重试", async () => {
    invokeMock.mockRejectedValueOnce(new Error("库打不开"))
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("库打不开")
    mockCorrectInvoke({ edges: [makeCorrectionEdge()] })
    fireEvent.click(screen.getByTestId("canon-refresh"))
    expect(await screen.findByText("KNOWS")).toBeInTheDocument()
  })

  it("非 Error 拒绝展示兜底文案", async () => {
    invokeMock.mockRejectedValueOnce("raw")
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("canon_query_batch 调用失败")
  })

  it("无边时展示空态（过滤控件已具备，文案有对应控件）", async () => {
    mockCorrectInvoke({ edges: [], maxRevision: 0 })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    expect(await screen.findByTestId("canon-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("correction-panel")).not.toBeInTheDocument()
  })

  it("选中行打开校正面板并预填，取消关闭", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    expect(screen.getByTestId("correction-panel")).toBeInTheDocument()
    expect(screen.getByTestId("correction-pov-chip-pov:alpha")).toBeInTheDocument()
    expect(screen.getByTestId("correction-revealed-at")).toHaveValue("4")
    expect(screen.getByTestId("correction-save")).toBeDisabled()
    fireEvent.click(screen.getByTestId("correction-cancel"))
    expect(screen.queryByTestId("correction-panel")).not.toBeInTheDocument()
  })

  it("白名单外 POV 在触达 IPC 前被拦截", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-pov-input"), {
      target: { value: "pov:stranger" },
    })
    fireEvent.click(screen.getByTestId("correction-pov-add"))
    expect(screen.getByTestId("correction-pov-error")).toHaveTextContent(/不在项目角色白名单内/)
    expect(screen.getByTestId("correction-pov-chip-pov:alpha")).toBeInTheDocument()
    expect(screen.queryByTestId("correction-pov-chip-pov:stranger")).not.toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("移除 POV chip 不受白名单限制", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.click(screen.getByLabelText("移除 pov:alpha"))
    expect(screen.queryByTestId("correction-pov-chip-pov:alpha")).not.toBeInTheDocument()
  })

  it("白名单内 POV 加入草稿 chips", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-pov-input"), { target: { value: "pov:beta" } })
    fireEvent.click(screen.getByTestId("correction-pov-add"))
    expect(screen.getByTestId("correction-pov-chip-pov:beta")).toBeInTheDocument()
    expect(screen.getByTestId("correction-pov-input")).toHaveValue("")
  })

  it("保存时暴露违规且不调用 canon_supersede_edges", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "1" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(
      screen.getAllByRole("alert").map((el) => el.textContent).join("\n"),
    ).toContain("revealed_before_valid")
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "abc" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(
      screen.getAllByRole("alert").map((el) => el.textContent).join("\n"),
    ).toContain("invalid_revealed_at")
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("保存有效校正经 canon_supersede_edges 并自动重载边列表（③-2）", async () => {
    mockCorrectInvoke({ edges: [makeCorrectionEdge()], maxRevision: 8 })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "5" } })
    fireEvent.click(screen.getByTestId("correction-save"))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("canon_supersede_edges", {
        projectId: PROJECT_ID,
        request: expect.objectContaining({
          old_edge_ids: ["e1"],
          cap_chapter: 3,
          new_edges: [
            expect.objectContaining({
              known_by: ["pov:alpha"],
              revealed_at: 5,
              id: expect.stringMatching(/^corr:e1:/),
            }),
          ],
        }),
      }),
    )
    expect(await screen.findByTestId("correction-saved")).toHaveTextContent(
      /封顶 1 条 · 插入 1 条 · revision → 8/,
    )
    // 挂载查询(1) + 进入校正查询(2) + supersede(3) + 保存后重载(4)
    expect(invokeMock).toHaveBeenCalledTimes(4)
    expect(screen.queryByTestId("correction-panel")).not.toBeInTheDocument()
  })

  it("写 IPC 拒绝时保持面板打开并展示错误", async () => {
    mockCorrectInvoke({
      edges: [makeCorrectionEdge()],
      maxRevision: 1,
      onSupersede: () => {
        throw new Error("写锁被占")
      },
    })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "6" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(await screen.findByTestId("correction-save-error")).toHaveTextContent("写锁被占")
    expect(screen.getByTestId("correction-panel")).toBeInTheDocument()
    const queryCalls = invokeMock.mock.calls.filter((c) => c[0] === "canon_query_batch")
    expect(queryCalls).toHaveLength(2) // 挂载查询 + 进入校正查询
  })

  it("非 Error 写拒绝展示兜底文案", async () => {
    mockCorrectInvoke({
      edges: [makeCorrectionEdge()],
      onSupersede: () => {
        throw "boom"
      },
    })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "6" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(await screen.findByTestId("correction-save-error")).toHaveTextContent(
      "canon_supersede_edges 调用失败",
    )
  })

  it("在两条不同选中行间切换时重置草稿", async () => {
    mockCorrectInvoke({
      edges: [
        makeCorrectionEdge({ id: "e1", revealed_at: 4 }),
        makeCorrectionEdge({ id: "e2", predicate: "BESIEGES", known_by: ["pov:beta"], revealed_at: null }),
      ],
    })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await enterCorrectMode()
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    expect(screen.getByTestId("correction-revealed-at")).toHaveValue("4")
    fireEvent.click(screen.getByTestId("canon-select-e2"))
    expect(screen.getByTestId("correction-revealed-at")).toHaveValue("")
    expect(screen.getByTestId("correction-pov-chip-pov:beta")).toBeInTheDocument()
    expect(screen.queryByTestId("correction-pov-chip-pov:alpha")).not.toBeInTheDocument()
  })
})
