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
