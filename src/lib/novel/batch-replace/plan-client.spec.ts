/** C4 冒烟覆盖：src/lib/novel/batch-replace/plan-client.ts（自动生成，核心行为由专项 spec 加深） */
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

import { describe, expect, it, vi } from "vitest"
import type { FileDiffModel } from "./diff-model"
import type { PreWriteGateInput } from "../canon-pre-write-gate"
import { BATCH_REPLACE_OP, GATE_CONFIRM_PREFIX, GATE_DENIED_PREFIX, previewBatchReplace, applyBatchReplace, isGateRequireConfirm, isGateDenied, isTransactionRolledBack, buildEdgesFromPlan, preflightCanonEdgeGate, isPlanBlockedByCanonGate } from "./plan-client"
describe("plan-client.ts smoke", () => {
  it("exports BATCH_REPLACE_OP", () => {
    expect(BATCH_REPLACE_OP).toBeDefined()
  })
  it("exports GATE_CONFIRM_PREFIX", () => {
    expect(GATE_CONFIRM_PREFIX).toBeDefined()
  })
  it("exports GATE_DENIED_PREFIX", () => {
    expect(GATE_DENIED_PREFIX).toBeDefined()
  })
  it("exports previewBatchReplace", () => {
    expect(previewBatchReplace).toBeDefined()
  })
  it("exports applyBatchReplace", () => {
    expect(applyBatchReplace).toBeDefined()
  })
  it("exports isGateRequireConfirm", () => {
    expect(isGateRequireConfirm).toBeDefined()
  })
  it("exports isGateDenied", () => {
    expect(isGateDenied).toBeDefined()
  })
  it("exports isTransactionRolledBack", () => {
    expect(isTransactionRolledBack).toBeDefined()
  })
  it("exports buildEdgesFromPlan", () => {
    expect(buildEdgesFromPlan).toBeDefined()
  })
  it("exports preflightCanonEdgeGate", () => {
    expect(preflightCanonEdgeGate).toBeDefined()
  })
  it("exports isPlanBlockedByCanonGate", () => {
    expect(isPlanBlockedByCanonGate).toBeDefined()
  })
})

const REQ = {
  projectPath: "/P",
  files: ["/P/wiki/a.md"],
  rule: { find: "旧词", replace: "新词" },
}

function fileDiff(overrides: Partial<FileDiffModel> = {}): FileDiffModel {
  return { path: "wiki/a.md", replacements: 2, changes: [], ...overrides }
}

describe("plan-client IPC 分发（invoke 参数口径）", () => {
  it("previewBatchReplace 走 batch_replace_preview，并把线上规则转成 snake_case", async () => {
    const diffs = [fileDiff()]
    invokeMock.mockResolvedValue(diffs)
    await expect(previewBatchReplace(REQ)).resolves.toEqual(diffs)
    expect(invokeMock).toHaveBeenCalledWith("batch_replace_preview", {
      projectPath: "/P",
      files: ["/P/wiki/a.md"],
      rule: { find: "旧词", replace: "新词", case_sensitive: false },
    })
  })

  it("caseSensitive 显式开启时线上字段为 true", async () => {
    invokeMock.mockResolvedValue([])
    await previewBatchReplace({ ...REQ, rule: { ...REQ.rule, caseSensitive: true } })
    expect(invokeMock).toHaveBeenCalledWith(
      "batch_replace_preview",
      expect.objectContaining({ rule: { find: "旧词", replace: "新词", case_sensitive: true } }),
    )
  })

  it("applyBatchReplace 走 batch_replace_apply 并原样返回报告", async () => {
    const report = {
      applied: ["wiki/a.md"],
      drafts: [],
      backup_root: "/P/.novel/backup",
      total_replacements: 2,
      projection_status_updated: true,
      rollback_performed: false,
    }
    invokeMock.mockResolvedValue(report)
    await expect(applyBatchReplace(REQ)).resolves.toEqual(report)
    expect(invokeMock).toHaveBeenCalledWith("batch_replace_apply", {
      projectPath: "/P",
      files: ["/P/wiki/a.md"],
      rule: { find: "旧词", replace: "新词", case_sensitive: false },
    })
  })
})

describe("plan-client 错误分类（确认门 / 硬拒绝 / 事务回滚）", () => {
  it("GATE_REQUIRE_CONFIRM / GATE_DENIED / ROLLED_BACK 分别命中各自谓词", () => {
    const confirm = "BATCH_REPLACE_GATE_REJECTED: GATE_REQUIRE_CONFIRM:abc123"
    const denied = "BATCH_REPLACE_GATE_REJECTED: GATE_DENIED:unsafe-path"
    const rolledBack = "BATCH_REPLACE_ROLLED_BACK: restored 3 files"

    expect(isGateRequireConfirm(confirm)).toBe(true)
    expect(isGateDenied(confirm)).toBe(false)

    expect(isGateDenied(denied)).toBe(true)
    expect(isGateRequireConfirm(denied)).toBe(false)

    expect(isTransactionRolledBack(rolledBack)).toBe(true)
    expect(isGateRequireConfirm(rolledBack)).toBe(false)

    expect(isGateRequireConfirm("plain failure")).toBe(false)
    expect(isGateDenied(new Error("GATE_DENIED: x"))).toBe(true)
    expect(isTransactionRolledBack(new Error("BATCH_REPLACE_ROLLED_BACK"))).toBe(true)
  })
})

describe("plan-client 写前 canon 门（提交前预检）", () => {
  it("空 find / 无命中文件的计划不产边（PASS）", () => {
    expect(buildEdgesFromPlan([fileDiff()], { find: "", replace: "新词" })).toEqual([])
    expect(buildEdgesFromPlan([fileDiff({ replacements: 0 })], REQ.rule)).toEqual([])

    const passing = preflightCanonEdgeGate([], REQ.rule, [], undefined)
    expect(passing.state).toBe("PASS")
    expect(isPlanBlockedByCanonGate(passing)).toBe(false)
  })

  it("每个命中文件产出一条 replaced_by 边（含幂等 digest）", () => {
    const edges = buildEdgesFromPlan(
      [fileDiff({ path: "wiki/a.md", replacements: 2 }), fileDiff({ path: "wiki/b.md", replacements: 0 })],
      REQ.rule,
    )
    expect(edges).toEqual([
      {
        id: "batch:wiki/a.md:旧词->新词",
        sourceId: "旧词",
        targetId: "新词",
        predicate: "replaced_by",
        digest: "wiki/a.md#2",
        validAt: null,
        invalidAt: null,
      },
    ])
  })

  it("同 source+predicate 异 target 的冲突在默认 warn 模式下降级 WARN，block 模式才 BLOCK", () => {
    const existingEdges: PreWriteGateInput["existingEdges"] = [
      {
        id: "canon:existing",
        sourceId: "旧词",
        targetId: "第三词",
        predicate: "replaced_by",
        digest: "canon#1",
        validAt: null,
        invalidAt: null,
      },
    ]
    const files = [fileDiff({ path: "wiki/a.md", replacements: 2 })]

    const observed = preflightCanonEdgeGate(files, REQ.rule, existingEdges)
    expect(observed.state).toBe("WARN")
    expect(observed.conflicts).toHaveLength(1)
    expect(observed.conflicts[0].code).toBe("block_endpoint_conflict")
    expect(isPlanBlockedByCanonGate(observed)).toBe(false)

    const blocked = preflightCanonEdgeGate(files, REQ.rule, existingEdges, { mode: "block" })
    expect(blocked.state).toBe("BLOCK")
    expect(isPlanBlockedByCanonGate(blocked)).toBe(true)
  })

  it("无既有冲突边 → PASS（不误拦合法替换）", () => {
    const result = preflightCanonEdgeGate([fileDiff()], REQ.rule, [
      { id: "canon:other", sourceId: "无关旧词", targetId: "无关新词", predicate: "replaced_by" },
    ])
    expect(result.state).toBe("PASS")
    expect(result.conflicts).toEqual([])
  })
})
