// @vitest-environment jsdom
//
// canon-editor.tsx（T29b / F-01 写路径）spec。
//
// 覆盖：
//   1. 纯函数：makeCorrectionId / computeCorrectionDigest /
//      buildSupersedeRequestForCorrection（字段继承 + 认知轴补丁 + cap 语义）；
//   2. 校验：known_by 白名单（fail-closed）+ revealed_at 时态不变量
//      （与 Rust validate_edge_temporal 对齐）；
//   3. UI 可观测：列表加载 / max_revision / 选择行 → 校正面板 /
//      无变更禁存 / 增补 POV 白名单拦截（不触达 IPC）/ 违规渲染（不触达 IPC）/
//      保存成功 payload 形状（camelCase projectId + snake_case request）/
//      保存后重载 / IPC 失败兜底。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test-helpers/component-test-utils"
import type { RawCanonEdge } from "@/lib/novel/canon-graph-client"
import {
  CanonEditor,
  buildSupersedeRequestForCorrection,
  computeCorrectionDigest,
  makeCorrectionId,
  validateKnownByCorrection,
  validateRevealedAtCorrection,
} from "./canon-editor"

// ── invoke mock（唯一 IPC 缝合点）──────────────────────────────────
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

const PROJECT_ID = "proj-1"
const ALLOWLIST = ["pov:alpha", "pov:beta", "pov:gamma"]

function makeEdge(overrides: Partial<RawCanonEdge> = {}): RawCanonEdge {
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
function mockInvokeHandlers(handlers: {
  edges?: RawCanonEdge[]
  maxRevision?: number
  onSupersede?: () => Promise<unknown> | unknown
}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "canon_query_batch") {
      return { results: [handlers.edges ?? []], max_revision: handlers.maxRevision ?? 7 }
    }
    if (cmd === "canon_supersede_edges") {
      if (handlers.onSupersede) return await handlers.onSupersede()
      return { result: { capped: 1, inserted: 1, missing: [] }, max_revision: 8 }
    }
    throw new Error(`unexpected command: ${cmd}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvokeHandlers({ edges: [makeEdge()] })
})

afterEach(() => cleanup())

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
    const old = makeEdge({
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
    // supersede 形状
    expect(req.old_edge_ids).toEqual(["e9"])
    expect(req.cap_chapter).toBe(3)
    expect(req.new_edges).toHaveLength(1)
    // §B causedBy：人工校正 supersede 的审计溯源标记
    expect(req.caused_by).toBe("manual-correction")
    // 后继边：id 全新、认知轴打补丁、世界时态与技法列原样继承
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
    // digest 重算且非空
    expect(next.digest).toBeTruthy()
    expect(next.digest).not.toBe(old.digest)
  })

  it("caps at 0 when valid_at is absent and inherits an already-capped interval", () => {
    const dead = makeEdge({ id: "d1", valid_at: null, invalid_at: 12 })
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

    // 白名单为空 = 禁止一切增补（POV 防泄密 fail-closed）
    const none = validateKnownByCorrection(["pov:alpha"], [])
    expect(none.ok).toBe(false)
    expect(none.violations[0]!.code).toBe("not_in_allowlist")

    // 移除方向不受白名单限制（缩减知晓集永不泄密）：空草稿恒通过
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

// ── UI 可观测行为 ──────────────────────────────────────────────────

describe("CanonEditor (write path)", () => {
  it("loads edges via canon_query_batch and shows max_revision", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("canon_query_batch", {
        projectId: PROJECT_ID,
        filters: [{}],
      }),
    )
    expect(await screen.findByText("KNOWS")).toBeInTheDocument()
    expect(screen.getByTestId("canon-max-revision")).toHaveTextContent("7")
  })

  it("shows the query error state when loading fails and can retry via refresh", async () => {
    invokeMock.mockRejectedValueOnce(new Error("库打不开"))
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("库打不开")
    mockInvokeHandlers({ edges: [makeEdge()] })
    fireEvent.click(screen.getByTestId("canon-refresh"))
    expect(await screen.findByText("KNOWS")).toBeInTheDocument()
  })

  it("renders a non-Error query rejection with the fallback message", async () => {
    invokeMock.mockRejectedValueOnce("raw")
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("canon_query_batch 调用失败")
  })

  it("shows the empty state when no edges are returned", async () => {
    mockInvokeHandlers({ edges: [], maxRevision: 0 })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    expect(await screen.findByTestId("canon-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("correction-panel")).not.toBeInTheDocument()
  })

  it("opens the correction panel prefilled when a row is selected and closes on cancel", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    expect(screen.getByTestId("correction-panel")).toBeInTheDocument()
    expect(screen.getByTestId("correction-pov-chip-pov:alpha")).toBeInTheDocument()
    expect(screen.getByTestId("correction-revealed-at")).toHaveValue("4")
    // 未做任何修改 → 保存禁用（无变更守卫）
    expect(screen.getByTestId("correction-save")).toBeDisabled()
    // 取消关闭面板
    fireEvent.click(screen.getByTestId("correction-cancel"))
    expect(screen.queryByTestId("correction-panel")).not.toBeInTheDocument()
  })

  it("blocks adding a POV outside the allowlist before any write reaches IPC", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-pov-input"), {
      target: { value: "pov:stranger" },
    })
    fireEvent.click(screen.getByTestId("correction-pov-add"))
    expect(screen.getByTestId("correction-pov-error")).toHaveTextContent(/不在项目角色白名单内/)
    // 草稿 chips 不变，仍只有原成员
    expect(screen.getByTestId("correction-pov-chip-pov:alpha")).toBeInTheDocument()
    expect(screen.queryByTestId("correction-pov-chip-pov:stranger")).not.toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("removes a POV chip without allowlist restriction", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.click(screen.getByLabelText("移除 pov:alpha"))
    expect(screen.queryByTestId("correction-pov-chip-pov:alpha")).not.toBeInTheDocument()
  })

  it("adds an allowlisted POV into the draft chips", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-pov-input"), { target: { value: "pov:beta" } })
    fireEvent.click(screen.getByTestId("correction-pov-add"))
    expect(screen.getByTestId("correction-pov-chip-pov:beta")).toBeInTheDocument()
    expect(screen.getByTestId("correction-pov-input")).toHaveValue("")
  })

  it("surfaces violations on save and never invokes canon_supersede_edges", async () => {
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    // revealed_at=1 早于 valid_at=3 → revealed_before_valid
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "1" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(screen.getAllByRole("alert").map((el) => el.textContent).join("\n")).toContain(
      "revealed_before_valid",
    )
    // 非法章号（text 输入框让非法值留在框内被校验拦截）
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "abc" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(screen.getAllByRole("alert").map((el) => el.textContent).join("\n")).toContain(
      "invalid_revealed_at",
    )
    expect(invokeMock).not.toHaveBeenCalledWith("canon_supersede_edges", expect.anything())
  })

  it("saves a valid correction through canon_supersede_edges and reloads the list", async () => {
    mockInvokeHandlers({ edges: [makeEdge()], maxRevision: 8 })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    // revealed_at 改为 5（>= valid_at=3），known_by 保持 alpha
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
    // 保存成功回执 + 保存后重载（query 第二次）
    expect(await screen.findByTestId("correction-saved")).toHaveTextContent(
      /封顶 1 条 · 插入 1 条 · revision → 8/,
    )
    expect(invokeMock).toHaveBeenCalledTimes(3) // 初始 query + supersede + 重载 query
    // 保存后面板已收起
    expect(screen.queryByTestId("correction-panel")).not.toBeInTheDocument()
  })

  it("keeps the panel open and shows the error when the write IPC rejects", async () => {
    mockInvokeHandlers({
      edges: [makeEdge()],
      maxRevision: 1,
      onSupersede: () => {
        throw new Error("写锁被占")
      },
    })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "6" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(await screen.findByTestId("correction-save-error")).toHaveTextContent("写锁被占")
    expect(screen.getByTestId("correction-panel")).toBeInTheDocument()
    // 失败不触发重载：query 只调了初始一次
    const queryCalls = invokeMock.mock.calls.filter((c) => c[0] === "canon_query_batch")
    expect(queryCalls).toHaveLength(1)
  })

  it("treats a non-Error write rejection with the fallback message", async () => {
    mockInvokeHandlers({
      edges: [makeEdge()],
      onSupersede: () => {
        throw "boom"
      },
    })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    fireEvent.change(screen.getByTestId("correction-revealed-at"), { target: { value: "6" } })
    fireEvent.click(screen.getByTestId("correction-save"))
    expect(await screen.findByTestId("correction-save-error")).toHaveTextContent(
      "canon_supersede_edges 调用失败",
    )
  })

  it("resets drafts when switching between two different selected rows", async () => {
    mockInvokeHandlers({
      edges: [
        makeEdge({ id: "e1", revealed_at: 4 }),
        makeEdge({ id: "e2", predicate: "BESIEGES", known_by: ["pov:beta"], revealed_at: null }),
      ],
    })
    render(<CanonEditor projectId={PROJECT_ID} povAllowlist={ALLOWLIST} />)
    fireEvent.click(await screen.findByTestId("canon-select-e1"))
    expect(screen.getByTestId("correction-revealed-at")).toHaveValue("4")
    fireEvent.click(screen.getByTestId("canon-select-e2"))
    expect(screen.getByTestId("correction-revealed-at")).toHaveValue("")
    expect(screen.getByTestId("correction-pov-chip-pov:beta")).toBeInTheDocument()
    expect(screen.queryByTestId("correction-pov-chip-pov:alpha")).not.toBeInTheDocument()
  })
})
