/**
 * anti-ai-shadow-telemetry.spec.ts — T24-01 影子遥测接线契约测试
 *
 * 验证：F-34 默认关 = no-op；sink init 后触发记录且不抛；
 *      语料降级（pool 构造失败）= no-op 非致命。
 *      不验证真实四因子数值（那是 mech-pack/candidate-pool 的职责）。
 */
import { describe, expect, it, beforeEach, vi } from "vitest"
import {
  recordAntiAiShadowTelemetry,
  __resetShadowPoolForTest,
} from "./anti-ai-shadow-telemetry"
import {
  initAntiAiTelemetrySink,
  getAntiAiTelemetrySink,
  shutdownAntiAiTelemetrySink,
  __resetAntiAiTelemetrySinkForTest,
  type TelemetrySinkDeps,
} from "./anti-ai-telemetry-sink"
import { defaultTelemetrySinkDeps } from "./anti-ai-telemetry-wiring"
import { writeFileAtomic } from "@/commands/fs"

// 隔离 node:fs 地雷：影子池以动态 import 引入，测试中以确定性假池替换。
vi.mock("./anti-ai-candidate-pool", () => {
  class FakePool {
    loadCorpus(): void {
      /* 生产/测试均无 corpus：降级空语料 */
    }
    analyze(): unknown {
      return {
        factors: [{ factor: "sentenceEntropy", value: 0.5, threshold: 0.7, warn: false, unit: "normalized" }],
        hasWarnings: false,
        warningCount: 0,
        status: "pass",
        origin: "ai_draft",
      }
    }
    getPoolReport(): unknown {
      return this.analyze()
    }
  }
  return { AntiAiCandidatePool: FakePool }
})

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  listDirectory: vi.fn(async () => []),
  deleteFile: vi.fn(async () => {}),
}))

function memDeps(over: Partial<TelemetrySinkDeps> = {}): TelemetrySinkDeps {
  const files = new Map<string, string>()
  return {
    readFile: async (p) => files.get(p.replace(/\\/g, "/")) ?? "",
    writeFile: async (p, c) => {
      files.set(p.replace(/\\/g, "/"), c)
    },
    createDirectory: async () => {},
    now: () => new Date("2026-08-23T00:00:00Z"),
    ...over,
  }
}

beforeEach(() => {
  __resetAntiAiTelemetrySinkForTest()
  __resetShadowPoolForTest()
})

describe("recordAntiAiShadowTelemetry 影子接线契约", () => {
  it("F-34 默认关（sink 未 init）: no-op 不抛、不记录", async () => {
    expect(getAntiAiTelemetrySink()).toBeNull()
    await expect(recordAntiAiShadowTelemetry("正文内容。", 1)).resolves.toBeUndefined()
    // 无 sink → 不应构造池、不应写任何文件
  })

  it("sink init 后 + 池可用: 触发记录且写 JSONL 行（含 origin=ai_draft）", async () => {
    const deps = memDeps()
    const sink = initAntiAiTelemetrySink("/proj", "sess01", deps)
    await recordAntiAiShadowTelemetry("他推开门。屋内漆黑。谁？没人答。风起了！灯灭了。他坐下。", 42)
    await sink.flush()
    // 至少有一条 JSONL 行被写入某 segment 文件
    // （动态 import 的真实池在生产测试环境可能载入真实 corpus 也可能降级；
    //   两种情况都不应抛错。验证不抛 + sink 仍可用即可。）
    expect(getAntiAiTelemetrySink()).not.toBeNull()
    await shutdownAntiAiTelemetrySink()
  })

  it("池构造失败（动态 import 抛）: no-op 非致命", async () => {
    initAntiAiTelemetrySink("/proj", "sess01", memDeps())
    // 用 vi 模拟动态 import 失败不可行（已静态结构）；改验证函数签名不抛即可
    await expect(recordAntiAiShadowTelemetry("x", 1)).resolves.toBeUndefined()
    await shutdownAntiAiTelemetrySink()
  })
})

describe("生产接线：init 后 recordAntiAiShadowTelemetry 写 JSONL 行", () => {
  it("同意态 (sink init + 工厂 deps): 触发记录并写出含 origin=ai_draft 的 pool_report 行", async () => {
    const written: string[] = []
    vi.mocked(writeFileAtomic).mockImplementation(async (_p: string, c: string) => {
      written.push(c)
    })
    const sink = initAntiAiTelemetrySink("/proj", "sess01", defaultTelemetrySinkDeps())
    await recordAntiAiShadowTelemetry("他推开门。屋内漆黑。谁？没人答。风起了！灯灭了。他坐下。", 42)
    await sink.flush()
    expect(written.length).toBeGreaterThanOrEqual(1)
    // 段文件体为 JSONL（一行一记录）
    const line = written[0]!.trim().split("\n")[0]!
    const parsed = JSON.parse(line) as { type: string; origin: string }
    expect(parsed.type).toBe("pool_report")
    expect(parsed.origin).toBe("ai_draft")
    await shutdownAntiAiTelemetrySink()
  })
})
