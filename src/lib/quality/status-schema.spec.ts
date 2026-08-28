/**
 * status-schema.spec.ts — v2.6.7 D3 验收
 *
 * 覆盖：字段白名单 / 未知字段拒绝 / 状态机校验 / 写路径硬失败
 */
import { describe, expect, it } from "vitest"
import { STATUS_SCHEMA_VERSION, validateBeforeWrite, validateStatusSchema } from "./status-schema"

const validStatus = {
  schemaVersion: STATUS_SCHEMA_VERSION,
  chapters: [
    { id: "ch1", title: "第一章", status: "accepted", content: "正文", knownBy: [], revealedAt: null },
  ],
  memories: [],
  settings: {},
  updatedAt: "2026-08-28T00:00:00.000Z",
}

describe("D3 契约 — 字段白名单 + 未知字段拒绝", () => {
  it("合法 status.json 通过校验", () => {
    expect(validateStatusSchema(validStatus).valid).toBe(true)
  })

  it("未知顶层字段拒绝", () => {
    const r = validateStatusSchema({ ...validStatus, extraField: 1 })
    expect(r.valid).toBe(false)
    expect(r.errors.join("; ")).toContain("未知字段: extraField")
  })

  it("schemaVersion 不匹配拒绝", () => {
    const r = validateStatusSchema({ ...validStatus, schemaVersion: "old-v0" })
    expect(r.valid).toBe(false)
    expect(r.errors.join("; ")).toContain("schemaVersion")
  })

  it("非对象拒绝", () => {
    expect(validateStatusSchema(null).valid).toBe(false)
    expect(validateStatusSchema("string").valid).toBe(false)
  })
})

describe("D3 章节校验 — 状态机 + 字段白名单", () => {
  it("章节非法状态拒绝（必须 pending/ready/accepted）", () => {
    const r = validateStatusSchema({
      ...validStatus,
      chapters: [{ id: "ch1", status: "draft" }],
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join("; ")).toContain("章节非法状态")
  })

  it("章节未知字段拒绝", () => {
    const r = validateStatusSchema({
      ...validStatus,
      chapters: [{ id: "ch1", status: "accepted", bogus: true }],
    })
    expect(r.valid).toBe(false)
    expect(r.errors.join("; ")).toContain("章节未知字段: bogus")
  })

  it("chapters 非数组拒绝", () => {
    const r = validateStatusSchema({ ...validStatus, chapters: "not-array" })
    expect(r.valid).toBe(false)
  })
})

describe("D3 写路径硬失败（不静默 coerce）", () => {
  it("合法数据可写", () => {
    expect(validateBeforeWrite(validStatus).valid).toBe(true)
  })

  it("非法数据拒绝写入（硬失败——不静默修正）", () => {
    const r = validateBeforeWrite({ ...validStatus, schemaVersion: 123 })
    expect(r.valid).toBe(false)
  })
})
