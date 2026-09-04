/**
 * E-04 (run-execute-1, 双库架构蓝图 EPIC-04) — 审计三口诀接线 spec。
 *
 * 覆盖: checkConsistency 纯函数 (PASS/BLOCK 边界) / appendAuditFindings JSONL
 * sink (schema + severity 三级 + 幂等去重) / runAuditTriadPreflight (BLOCK →
 * error 结果; 无 critical → 空; 审计异常 → 显式「审计未完成」warning) /
 * gate 键回归 (三口诀 type 经 toConsistencyReviewResult 归一后归 consistency gate)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_p: string): Promise<string> => { throw new Error("ENOENT") }),
  writeFileAtomic: vi.fn(async (_p: string, _c: string) => {}),
  createDirectory: vi.fn(async (_p: string) => {}),
  fileExists: vi.fn(async (_p: string) => false),
  listDirectory: vi.fn(async (_p: string) => []),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: [string]) => fsMocks.readFile(...args),
  writeFileAtomic: (...args: [string, string]) => fsMocks.writeFileAtomic(...args),
  createDirectory: (...args: [string]) => fsMocks.createDirectory(...args),
  fileExists: (...args: [string]) => fsMocks.fileExists(...args),
  listDirectory: (...args: [string]) => fsMocks.listDirectory(...args),
}))

import {
  checkConsistency,
  appendAuditFindings,
  runAuditTriadPreflight,
  resolveReviewGateKey,
} from "./review-adapter"
import { toConsistencyReviewResult } from "./deterministic-continuity-engine"
import type { ContinuityFinding } from "./deterministic-continuity-engine"

function finding(overrides: Partial<ContinuityFinding> = {}): ContinuityFinding {
  return {
    type: "knowledge_boundary",
    subtype: "consistency_mechanical",
    severity: "critical",
    ref: "character:甲",
    message: "测试 finding",
    chapter: 5,
    evidence: "doesNotKnow:密道位置",
    ...overrides,
  } as ContinuityFinding
}

describe("E-04 checkConsistency（PASS/BLOCK 边界）", () => {
  it("无 critical → PASS", () => {
    expect(checkConsistency([finding({ severity: "warning" }), finding({ severity: "info" })])).toEqual({
      decision: "PASS",
      critical: [],
    })
  })

  it("存在 critical + consistency_mechanical → BLOCK 且返回 critical 清单", () => {
    const f = finding()
    const gate = checkConsistency([finding({ severity: "warning" }), f])
    expect(gate.decision).toBe("BLOCK")
    expect(gate.critical).toEqual([f])
  })

  it("critical 但 subtype=data_gap → 不 BLOCK（IC-02 不静默降级但也不阻断）", () => {
    const gate = checkConsistency([finding({ subtype: "data_gap", severity: "info" })])
    expect(gate.decision).toBe("PASS")
  })

  it("纯函数幂等：同输入重算同结论（可逆性：无持久 BLOCK 状态）", () => {
    const findings = [finding()]
    expect(checkConsistency(findings)).toEqual(checkConsistency(findings))
  })
})

describe("E-04 appendAuditFindings（JSONL sink）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockClear()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
    fsMocks.fileExists.mockClear()
  })

  it("落盘行含四字段 MUST + severity 三级校验；空 findings 不写", async () => {
    await appendAuditFindings("/P", [])
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    await appendAuditFindings("/P", [finding()])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, contents] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(path).toBe("/P/.novel/audit-findings.jsonl")
    const line = JSON.parse(contents.trim().split("\n")[0])
    expect(line.type).toBe("knowledge_boundary")
    expect(line.severity).toBe("critical")
    expect(line.chapter).toBe(5)
    expect(line.evidence).toBe("doesNotKnow:密道位置")
    expect(line.ref).toBe("character:甲")
  })

  it("幂等：同 finding 重跑不重复追加（重审计字节级可复现）", async () => {
    await appendAuditFindings("/P", [finding()])
    const [, contents] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(contents)
    fsMocks.writeFileAtomic.mockClear()
    await appendAuditFindings("/P", [finding()])
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("sink 失败降级：写异常仅 log warn 不抛出（观测层失败不阻断审计门）", async () => {
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))
    await expect(appendAuditFindings("/P", [finding()])).resolves.toBeUndefined()
  })
})

describe("E-04 runAuditTriadPreflight（审查侧接线）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockClear()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
    fsMocks.fileExists.mockClear()
    fsMocks.readFile.mockImplementation(async () => { throw new Error("ENOENT") })
    fsMocks.fileExists.mockImplementation(async () => false)
  })

  it("无 critical → 返回空（warning/info 不阻断）", async () => {
    const results = await runAuditTriadPreflight("/P", 5, { chapterText: "甲在集市闲逛。" })
    expect(results).toEqual([])
  })

  it("审计异常 → 显式「审计未完成」warning（不伪装 PASS）", async () => {
    fsMocks.readFile.mockImplementation(async () => { throw new Error("corrupt store") })
    const results = await runAuditTriadPreflight("/P", 5, { chapterText: "甲在集市闲逛。" })
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe("warning")
    expect(results[0].message).toContain("审计未完成")
  })

  it("chapterNumber 缺失 → 空（不阻断）", async () => {
    const results = await runAuditTriadPreflight("/P", 0)
    expect(results).toEqual([])
  })
})

describe("E-04 gate 键回归（三口诀 type 归一后归 consistency gate P0）", () => {
  it("knowledge_boundary / lost_item / unresolved_foreshadowing 经 toConsistencyReviewResult → consistency", () => {
    const types: ContinuityFinding["type"][] = [
      "knowledge_boundary",
      "lost_item",
      "unresolved_foreshadowing",
    ]
    for (const type of types) {
      const results = toConsistencyReviewResult([finding({ type })])
      expect(results[0].type).toBe("consistency_mechanical")
      expect(resolveReviewGateKey(results[0].type)).toBe("consistency")
    }
  })

  it("原生 lost_item / unresolved_foreshadowing 不进 gate 链路（注册表陷阱回归）", () => {
    // 原生 type 若直接进 resolveReviewGateKey 会保守落 quality (P2) — 这正是
    // E-04 必须经 toConsistencyReviewResult 归一的原因 (N-3 注册表陷阱)。
    expect(resolveReviewGateKey("lost_item")).toBe("quality")
    expect(resolveReviewGateKey("unresolved_foreshadowing")).toBe("quality")
    expect(resolveReviewGateKey("knowledge_boundary")).toBe("consistency")
  })
})
