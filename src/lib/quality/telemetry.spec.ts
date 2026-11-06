/**
 * telemetry.spec.ts — v2.6.7 D2 验收
 *
 * 覆盖：3 事件白名单 / jsonl 序列化 / 10MB 滚动 / 隐私门
 */
import { describe, expect, it } from "vitest"
import {
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_ROLL_BYTES,
  privacyGate,
  rollFileName,
  serializeTelemetryLine,
  shouldRoll,
  validateTelemetryEvent,
  type TelemetryEvent,
} from "./telemetry"

const event: TelemetryEvent = {
  type: "app_launch",
  ts: "2026-08-28T00:00:00.000Z",
  payload: { version: "2.6.7" },
}

describe("D2 埋点 — 3 事件白名单（钉死——不混章节保存）", () => {
  it("事件类型钉死为 3 种", () => {
    expect(TELEMETRY_EVENT_TYPES).toEqual(["app_launch", "gen_done", "crash"])
  })

  it("合法事件通过校验", () => {
    expect(validateTelemetryEvent(event)).toHaveLength(0)
    expect(validateTelemetryEvent({ ...event, type: "gen_done" })).toHaveLength(0)
    expect(validateTelemetryEvent({ ...event, type: "crash" })).toHaveLength(0)
  })

  it("未知事件类型拒绝（防 PII 泄漏面——不混章节保存）", () => {
    const errors = validateTelemetryEvent({ ...event, type: "chapter_save" as never })
    expect(errors.join("; ")).toContain("未知事件类型")
  })

  it("缺 ts 或 ts 为空串时报错，且不误伤合法事件", () => {
    expect(validateTelemetryEvent({ ...event, ts: "" })).toContain("ts 不能为空")
    expect(validateTelemetryEvent({ ...event, ts: undefined as never })).toContain("ts 不能为空")
    expect(validateTelemetryEvent(event)).not.toContain("ts 不能为空")
  })

  it("payload 缺失或非对象时报错，且不误伤合法对象负载", () => {
    expect(validateTelemetryEvent({ ...event, payload: undefined as never })).toContain("payload 必须为对象")
    expect(validateTelemetryEvent({ ...event, payload: null as never })).toContain("payload 必须为对象")
    expect(validateTelemetryEvent({ ...event, payload: "oops" as never })).toContain("payload 必须为对象")
    expect(validateTelemetryEvent(event)).not.toContain("payload 必须为对象")
  })

  it("单次校验可同时报出全部三类错误（错误累加而非早退）", () => {
    const errors = validateTelemetryEvent({
      type: "unknown" as never,
      ts: "",
      payload: null as never,
    })
    expect(errors).toEqual(["未知事件类型: unknown", "ts 不能为空", "payload 必须为对象"])
  })
})

describe("D2 jsonl 序列化 + 10MB 滚动", () => {
  it("序列化为单行 JSON", () => {
    const line = serializeTelemetryLine(event)
    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line)).toEqual(event)
  })

  it("滚动阈值 10MB", () => {
    expect(TELEMETRY_ROLL_BYTES).toBe(10 * 1024 * 1024)
    expect(shouldRoll(10 * 1024 * 1024 - 1)).toBe(false)
    expect(shouldRoll(10 * 1024 * 1024)).toBe(true)
  })

  it("滚动文件名带时间戳后缀", () => {
    expect(rollFileName("draft", "2026-08-28T00:00:00.000Z")).toContain("2026-08-28T00-00-00")
  })
})

describe("D2 隐私门（invoke 前 gate——防 Rust 直写绕过）", () => {
  it("enabled 允许采集", () => {
    expect(privacyGate("enabled")).toBe(true)
  })

  it("disabled 拒绝采集", () => {
    expect(privacyGate("disabled")).toBe(false)
  })
})
