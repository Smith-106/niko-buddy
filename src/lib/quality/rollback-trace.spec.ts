/**
 * rollback-trace.spec.ts — v2.7.2 回滚 trace 验收
 *
 * 覆盖：强制字段完整 / 静默回滚=0
 */
import { describe, expect, it } from "vitest"
import { auditTrace, type RollbackTrace } from "./rollback-trace"

const tr = (id: string, complete = true): RollbackTrace => ({
  eventId: id,
  chapterId: "c1",
  gate: "P0",
  reason: complete ? "consistency drift 0.12" : "",
  scope: complete ? "draft-3" : "",
  hashBefore: complete ? "h1" : "",
  hashAfter: complete ? "h2" : "",
  manualChannelAvailable: complete,
})

describe("回滚 trace — 强制落盘", () => {
  it("全部完整 → 静默=0 通过", () => {
    const r = auditTrace([tr("e1"), tr("e2"), tr("e3")])
    expect(r.complete).toBe(3)
    expect(r.silent).toBe(0)
    expect(r.passed).toBe(true)
  })

  it("缺 trace → 静默回滚计数（P0 违规）", () => {
    const r = auditTrace([tr("e1"), tr("e2", false)])
    expect(r.silent).toBe(1)
    expect(r.passed).toBe(false)
  })

  it("人工回滚通道不可达 → 不完整", () => {
    const t = tr("e1")
    t.manualChannelAvailable = false
    const r = auditTrace([t])
    expect(r.silent).toBe(1)
    expect(r.passed).toBe(false)
  })
})
