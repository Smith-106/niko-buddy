/**
 * anti-ai-telemetry-wiring.spec.ts — #34 生产接线 + F-34 显式同意开关
 *
 * 验证：F-34 同意开关默认关 + save/load 往返；项目打开处按同意初始化 / 关闭 sink；
 *       项目切换先 flush 旧 sink（单例安全）。零真实 IO（@/commands/fs + @/lib/web-store 均 mock）。
 */
import { describe, expect, it, beforeEach, vi } from "vitest"

const fakeStore = vi.hoisted(() => {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: vi.fn(async (k: string) => (k in data ? data[k] : null)),
    set: vi.fn(async (k: string, v: unknown) => {
      data[k] = v
    }),
    save: vi.fn(async () => {}),
    reset() {
      for (const k of Object.keys(data)) delete data[k]
    },
  }
})

vi.mock("@/lib/web-store", () => ({
  getStore: vi.fn(async () => fakeStore),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  listDirectory: vi.fn(async () => []),
  deleteFile: vi.fn(async () => {}),
}))

import {
  loadAntiAiTelemetryConsent,
  saveAntiAiTelemetryConsent,
  applyAntiAiTelemetryConsentOnProjectOpen,
} from "./anti-ai-telemetry-wiring"
import {
  getAntiAiTelemetrySink,
  shutdownAntiAiTelemetrySink,
  __resetAntiAiTelemetrySinkForTest,
} from "./anti-ai-telemetry-sink"

beforeEach(() => {
  __resetAntiAiTelemetrySinkForTest()
  fakeStore.reset()
  fakeStore.get.mockClear()
  fakeStore.set.mockClear()
})

describe("F-34 同意开关持久化", () => {
  it("默认 false（未持久化 = 关 = 零 IO）", async () => {
    expect(await loadAntiAiTelemetryConsent()).toBe(false)
  })

  it("save → reload 往返", async () => {
    await saveAntiAiTelemetryConsent(true)
    expect(await loadAntiAiTelemetryConsent()).toBe(true)
    await saveAntiAiTelemetryConsent(false)
    expect(await loadAntiAiTelemetryConsent()).toBe(false)
  })
})

describe("applyAntiAiTelemetryConsentOnProjectOpen 门控", () => {
  it("同意=false → sink 保持 null（F-34 默认关契约）", async () => {
    await applyAntiAiTelemetryConsentOnProjectOpen("/proj")
    expect(getAntiAiTelemetrySink()).toBeNull()
  })

  it("同意=true → 初始化非 null；再开新项目先 flush 旧 sink（单例切换安全）", async () => {
    await saveAntiAiTelemetryConsent(true)
    await applyAntiAiTelemetryConsentOnProjectOpen("/projA")
    const s1 = getAntiAiTelemetrySink()
    expect(s1).not.toBeNull()
    // 第二次打开（同意仍 true）：先 flush 旧 sink，再 init 新 sink（单一 activeSink）
    await applyAntiAiTelemetryConsentOnProjectOpen("/projB")
    const s2 = getAntiAiTelemetrySink()
    expect(s2).not.toBeNull()
    expect(s2).not.toBe(s1)
    await shutdownAntiAiTelemetrySink()
  })

  it("会话中撤销同意：save(false) → 再 apply → sink 置空（UI 开关即时生效路径）", async () => {
    await saveAntiAiTelemetryConsent(true)
    await applyAntiAiTelemetryConsentOnProjectOpen("/projA")
    expect(getAntiAiTelemetrySink()).not.toBeNull()
    // UI 关闭开关（F-34 revoke）：apply 重读 store = false → shutdown 后不再 init
    await saveAntiAiTelemetryConsent(false)
    await applyAntiAiTelemetryConsentOnProjectOpen("/projA")
    expect(getAntiAiTelemetrySink()).toBeNull()
  })
})
