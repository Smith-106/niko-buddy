/**
 * anti-ai-shadow-telemetry.pool-down.spec.ts — 池不可用 / 无报告降级契约
 *
 * 与 anti-ai-shadow-telemetry.spec.ts 互补：那份锁定「池可用 → 记录」主链，
 * 本文件锁定三条降级路径的可观察行为（statement 缺口在此收敛）：
 *   1. 池构造失败（动态 import 侧 node:fs 不可达）→ no-op 非致命、零遥测写入；
 *   2. 构造失败结果被单例缓存 → 二次调用同样 no-op（不重试、不抛）；
 *   3. 池可用但文本无内容（空白）→ 规则栈不回调报告 → 不写遥测；
 *   4. chapterNumber 缺省 → 落盘行 chapter 归一为 0。
 *
 * 生产接线零改动：这里只喂不同的池 / 文本，断言「永不抛 + 永不阻塞 +
 * 无报告即不落盘」的外部契约。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const poolState = vi.hoisted(() => ({ failConstruct: false }))

// 可控假池：failConstruct=true 模拟「动态 import 到的池模块不可用」
// （生产对应 node:fs 不可达 → 构造失败 → 外层 catch 永久降级）。
vi.mock("./anti-ai-candidate-pool", () => {
  class ProbePool {
    constructor() {
      if (poolState.failConstruct) throw new Error("node:fs unavailable in this runtime")
    }
    loadCorpus(): void {
      /* 无 corpus：降级空语料 */
    }
    analyze(): unknown {
      return {
        factors: [
          { factor: "sentenceEntropy", value: 0.5, threshold: 0.7, warn: false, unit: "normalized" },
        ],
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
  return { AntiAiCandidatePool: ProbePool }
})

import {
  recordAntiAiShadowTelemetry,
  __resetShadowPoolForTest,
} from "./anti-ai-shadow-telemetry"
import {
  initAntiAiTelemetrySink,
  shutdownAntiAiTelemetrySink,
  __resetAntiAiTelemetrySinkForTest,
  type TelemetrySinkDeps,
} from "./anti-ai-telemetry-sink"

interface MemSink {
  deps: TelemetrySinkDeps
  /** 已落盘（flush）的全部段文件正文 */
  bodies: string[]
}

function memSink(): MemSink {
  const files = new Map<string, string>()
  const bodies: string[] = []
  const deps: TelemetrySinkDeps = {
    readFile: async (p: string) => files.get(p.replace(/\\/g, "/")) ?? "",
    writeFile: async (p: string, c: string) => {
      files.set(p.replace(/\\/g, "/"), c)
      bodies.push(c)
    },
    createDirectory: async () => {},
    now: () => new Date("2026-08-23T00:00:00Z"),
  }
  return { deps, bodies }
}

function poolReportLines(bodies: string[]): Array<Record<string, unknown>> {
  return bodies
    .join("\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.type === "pool_report")
}

beforeEach(() => {
  poolState.failConstruct = false
  __resetAntiAiTelemetrySinkForTest()
  __resetShadowPoolForTest()
})

describe("recordAntiAiShadowTelemetry 池降级契约", () => {
  it("池构造失败（node:fs 不可达）: no-op 非致命且零遥测写入", async () => {
    poolState.failConstruct = true
    const mem = memSink()
    const sink = initAntiAiTelemetrySink("/proj", "sess-down", mem.deps)

    await expect(
      recordAntiAiShadowTelemetry("他推开门。屋内漆黑。谁？没人答。", 7),
    ).resolves.toBeUndefined()
    await sink.flush()

    expect(poolReportLines(mem.bodies)).toHaveLength(0)
    await shutdownAntiAiTelemetrySink()
  })

  it("构造失败结果被单例缓存: 二次调用仍 no-op（不重试、不抛）", async () => {
    poolState.failConstruct = true
    const mem = memSink()
    const sink = initAntiAiTelemetrySink("/proj", "sess-down", mem.deps)

    await expect(recordAntiAiShadowTelemetry("第一章正文。", 1)).resolves.toBeUndefined()
    // 若二次调用重新构造池并抛错，调用方会看到 rejection —— 契约要求仍是 no-op。
    await expect(recordAntiAiShadowTelemetry("第二章正文。", 2)).resolves.toBeUndefined()
    await sink.flush()

    expect(poolReportLines(mem.bodies)).toHaveLength(0)
    await shutdownAntiAiTelemetrySink()
  })

  it("池可用但正文空白: 规则栈不求值报告 → 不写遥测", async () => {
    const mem = memSink()
    const sink = initAntiAiTelemetrySink("/proj", "sess-down", mem.deps)

    await expect(recordAntiAiShadowTelemetry("   \n\t ", 3)).resolves.toBeUndefined()
    await sink.flush()

    expect(poolReportLines(mem.bodies)).toHaveLength(0)
    await shutdownAntiAiTelemetrySink()
  })

  it("chapterNumber 缺省: 落盘 pool_report 的 chapter 归一为 0", async () => {
    const mem = memSink()
    const sink = initAntiAiTelemetrySink("/proj", "sess-down", mem.deps)

    await recordAntiAiShadowTelemetry("他推开门。屋内漆黑。谁？没人答。风起了！灯灭了。", undefined)
    await sink.flush()

    const lines = poolReportLines(mem.bodies)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ type: "pool_report", chapter: 0, origin: "ai_draft" })
    await shutdownAntiAiTelemetrySink()
  })
})
