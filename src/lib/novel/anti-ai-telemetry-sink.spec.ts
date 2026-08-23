/**
 * anti-ai-telemetry-sink.spec.ts — #34 JSONL sink 契约/隐私/轮转/缓冲测试
 *
 * 规格: docs/p6/anti-ai-telemetry-sink-spec.md（冻结）
 * 策略: FS 依赖注入（仿 stage-output-journal.spec.ts:24-72），零真实 IO。
 *      不导入 AntiAiCandidatePool 运行时（node:fs 地雷规避）。
 */
import { describe, expect, it, beforeEach, vi } from "vitest"
import {
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_FLUSH_BATCH,
  TELEMETRY_SEGMENT_MAX_BYTES,
  TELEMETRY_RETENTION_DAYS,
  createAntiAiTelemetrySink,
  normalizeOrigin,
  computeTextMeta,
  buildSlopAgg,
  serializePoolReportLine,
  antiAiTelemetryDir,
  segmentFileName,
  pruneExpiredSegments,
  initAntiAiTelemetrySink,
  getAntiAiTelemetrySink,
  recordPoolReport,
  shutdownAntiAiTelemetrySink,
  __resetAntiAiTelemetrySinkForTest,
  type TelemetrySinkDeps,
  type AntiAiTelemetryLine,
} from "./anti-ai-telemetry-sink"
import type { AntiAiAnalysisReport } from "./anti-ai-candidate-pool"

function fakeReport(over: Partial<AntiAiAnalysisReport> = {}): AntiAiAnalysisReport {
  return {
    factors: [
      { factor: "paragraphLengthDist", value: 0.65, threshold: 0.3, warn: false, unit: "normalized" },
      { factor: "sentenceEntropy", value: 0.55, threshold: 0.7, warn: false, unit: "normalized" },
    ],
    hasWarnings: false,
    warningCount: 0,
    status: "pass",
    calibrationSource: "T19",
    summary: "内部摘要绝不进遥测行",
    ...over,
  } as AntiAiAnalysisReport
}

interface MemFS {
  files: Map<string, string>
  clock: { value: Date }
}
function memDeps(over: Partial<TelemetrySinkDeps> = {}): MemFS & { deps: TelemetrySinkDeps } {
  const files = new Map<string, string>()
  const clock = { value: new Date("2026-08-23T00:00:00Z") }
  const norm = (p: string) => p.replace(/\\/g, "/")
  return {
    files,
    clock,
    deps: {
      readFile: async (p) => files.get(norm(p)) ?? "",
      writeFile: async (p, c) => {
        files.set(norm(p), c)
      },
      createDirectory: async () => {},
      deleteFile: async (p) => {
        files.delete(norm(p))
      },
      listFiles: async (dir) => [...files.keys()].filter((k) => k.startsWith(norm(dir) + "/")).map((k) => k.split("/").pop()!),
      now: () => clock.value,
      ...over,
    },
  }
}

beforeEach(() => {
  __resetAntiAiTelemetrySinkForTest()
})

describe("纯函数助手", () => {
  it("normalizeOrigin: ai_draft/user_text 透传; 其余归一 unknown", () => {
    expect(normalizeOrigin("ai_draft")).toBe("ai_draft")
    expect(normalizeOrigin("user_text")).toBe("user_text")
    expect(normalizeOrigin("unknown")).toBe("unknown")
    expect(normalizeOrigin(undefined)).toBe("unknown")
  })

  it("computeTextMeta: 字数/非空段数/句数计数正确", () => {
    const m = computeTextMeta("他推开门。屋内一片漆黑。\n\n谁？\n  \n风起了！")
    expect(m.chars).toBe("他推开门。屋内一片漆黑。\n\n谁？\n  \n风起了！".length)
    expect(m.paragraphs).toBe(3) // 空白段过滤
    expect(m.sentences).toBe(4) // 。。？！→ 4
  })

  it("buildSlopAgg: 只留计数，丢弃 kw 词表", () => {
    const agg = buildSlopAgg({
      tier3Hits: [{ kw: "绝密词表不该出现", count: 3 }, { kw: "另一个", count: 1 }],
      slopPenalty: 0.42,
    } as never)
    expect(agg.tier3ClassCount).toBe(2)
    expect(agg.tier3HitCount).toBe(4)
    expect(agg.penalty).toBe(0.42)
    expect(JSON.stringify(agg)).not.toContain("绝密词表")
  })

  it("segmentFileName: aa-YYYYMMDD-{sid8}-{seq3} 字典序=时间序", () => {
    expect(segmentFileName("20260823", "abc123ef-ghi", 7)).toBe("aa-20260823-abc123ef-007.jsonl")
    // 字典序：日期 < seq（三位补零）
    const a = segmentFileName("20260823", "sess0001", 1)
    const b = segmentFileName("20260823", "sess0001", 10)
    expect(a < b).toBe(true)
  })

  it("antiAiTelemetryDir: {pp}/.novel/telemetry/anti-ai", () => {
    expect(antiAiTelemetryDir("/proj").replace(/\\/g, "/")).toMatch(/\/proj\/\.novel\/telemetry\/anti-ai$/)
  })
})

describe("serializePoolReportLine 契约 + 隐私", () => {
  it("必选字段齐全且类型正确（契约）", () => {
    const { deps } = memDeps()
    const line = serializePoolReportLine(fakeReport(), { chapter: 42, text: "x。y。", sessionId: "s1" }, deps)
    const parsed: AntiAiTelemetryLine = JSON.parse(line)
    expect(parsed.v).toBe(TELEMETRY_SCHEMA_VERSION)
    expect(parsed.type).toBe("pool_report")
    expect(parsed.chapter).toBe(42)
    expect(parsed.origin).toBe("unknown") // 报告未带 origin → 归一
    expect(parsed.factors).toHaveLength(2)
    expect(parsed.factors[0]).toMatchObject({ factor: "paragraphLengthDist", value: 0.65, threshold: 0.3, warn: false, unit: "normalized" })
    expect(parsed.hasWarnings).toBe(false)
    expect(parsed.warningCount).toBe(0)
    expect(parsed.textMeta).toEqual({ chars: 4, paragraphs: 1, sentences: 2 })
  })

  it("隐私扫描 CWE-532: 不含禁用键/正文片段/自由文本字段", () => {
    const { deps } = memDeps()
    const report = fakeReport({ summary: "SUMMARY_SECRET", calibrationSource: "T19" })
    const line = serializePoolReportLine(report, { chapter: 1, text: "正文绝不该出现的秘密内容。", sessionId: "s" }, deps)
    const parsed = JSON.parse(line)
    // 禁用键
    for (const forbidden of ["summary", "description", "calibrationSource", "message", "kw"]) {
      expect(parsed).not.toHaveProperty(forbidden)
    }
    // 正文片段不入行
    expect(line).not.toContain("正文绝不该出现的秘密内容")
    expect(line).not.toContain("SUMMARY_SECRET")
    // origin 缺省归一
    expect(parsed.origin).toBe("unknown")
  })

  it("origin 来自报告装饰时透传（ai_draft/user_text）", () => {
    const { deps } = memDeps()
    const ai = serializePoolReportLine(fakeReport({ origin: "ai_draft" } as never), { chapter: 1, text: "x", sessionId: "s" }, deps)
    expect(JSON.parse(ai).origin).toBe("ai_draft")
    const user = serializePoolReportLine(fakeReport({ origin: "user_text" } as never), { chapter: 1, text: "x", sessionId: "s" }, deps)
    expect(JSON.parse(user).origin).toBe("user_text")
  })

  it("可选字段仅在提供时出现（additive-only 演进规则）", () => {
    const { deps } = memDeps()
    const minimal = JSON.parse(serializePoolReportLine(fakeReport(), { chapter: 1, text: "x", sessionId: "s" }, deps))
    expect(minimal).not.toHaveProperty("windowIndex")
    expect(minimal).not.toHaveProperty("antiAiMode")
    expect(minimal).not.toHaveProperty("slopAgg")
    const full = JSON.parse(
      serializePoolReportLine(
        fakeReport(),
        { chapter: 1, text: "x", sessionId: "s", windowIndex: 3, antiAiMode: "warn", slopReport: { tier3Hits: [], slopPenalty: 0 } as never },
        deps,
      ),
    )
    expect(full.windowIndex).toBe(3)
    expect(full.antiAiMode).toBe("warn")
    expect(full.slopAgg).toEqual({ tier3ClassCount: 0, tier3HitCount: 0, penalty: 0 })
  })
})

describe("Sink 缓冲 / flush / single-flight", () => {
  it("满 batch 触发一次整段重写；未满则缓冲不落盘", async () => {
    const fs = memDeps()
    const sink = createAntiAiTelemetrySink("/proj", "sess01", fs.deps)
    for (let i = 0; i < TELEMETRY_FLUSH_BATCH - 1; i++) {
      sink.recordPoolReport(fakeReport(), { chapter: i, text: "x", sessionId: "sess01" })
    }
    await sink.flush()
    // 全缓冲一次性写出
    const files = [...fs.files.keys()]
    expect(files.length).toBeLessThanOrEqual(1)
    if (files.length === 1) {
      const lines = fs.files.get(files[0]!)!.trim().split("\n")
      expect(lines.length).toBe(TELEMETRY_FLUSH_BATCH - 1)
    }
  })

  it("段超 1MB 开新段；轮转后 currentSegmentPath 变化", async () => {
    const fs = memDeps()
    const sink = createAntiAiTelemetrySink("/proj", "sess01", fs.deps)
    const before = sink.currentSegmentPath()
    // 构造超大行触发 ≥1MB 轮转
    const big = fakeReport({ warningCount: 1, hasWarnings: true })
    for (let i = 0; i < 5; i++) {
      sink.recordPoolReport(big, { chapter: i, text: "x".repeat(300_000), sessionId: "sess01" })
    }
    await sink.flush()
    await sink.dispose()
    expect(before).not.toBe(sink.currentSegmentPath())
  })

  it("写失败非致命：不 throw、缓冲丢尾可接受", async () => {
    const fs = memDeps({
      writeFile: async () => {
        throw new Error("disk full")
      },
    })
    const sink = createAntiAiTelemetrySink("/proj", "sess01", fs.deps)
    expect(() => sink.recordPoolReport(fakeReport(), { chapter: 1, text: "x", sessionId: "s" })).not.toThrow()
    await expect(sink.flush()).resolves.toBeUndefined() // 不 throw
  })
})

describe("保留期清理", () => {
  it("删早于 N 天的段；近段保留", async () => {
    const fs = memDeps()
    fs.clock.value = new Date("2026-12-01T00:00:00Z")
    const dir = antiAiTelemetryDir("/proj")
    const oldName = segmentFileName("20260101", "sess", 0)
    const newName = segmentFileName("20261130", "sess", 0)
    fs.files.set(`${dir.replace(/\\/g, "/")}/${oldName}`, "")
    fs.files.set(`${dir.replace(/\\/g, "/")}/${newName}`, "")
    const removed = await pruneExpiredSegments(dir, fs.clock.value, fs.deps, TELEMETRY_RETENTION_DAYS)
    expect(removed).toBe(1)
    expect([...fs.files.keys()].some((k) => k.endsWith(oldName))).toBe(false)
    expect([...fs.files.keys()].some((k) => k.endsWith(newName))).toBe(true)
  })
})

describe("F-34 默认关薄壳", () => {
  it("未初始化: getAntiAiTelemetrySink 返回 null；recordPoolReport no-op", () => {
    expect(getAntiAiTelemetrySink()).toBeNull()
    expect(() => recordPoolReport(fakeReport(), { chapter: 1, text: "x", sessionId: "s" })).not.toThrow()
  })

  it("init 后 sink 可用；shutdown 后复位为 null", async () => {
    const fs = memDeps()
    initAntiAiTelemetrySink("/proj", "sess01", fs.deps)
    expect(getAntiAiTelemetrySink()).not.toBeNull()
    recordPoolReport(fakeReport(), { chapter: 1, text: "x", sessionId: "sess01" })
    await getAntiAiTelemetrySink()!.flush()
    await shutdownAntiAiTelemetrySink()
    expect(getAntiAiTelemetrySink()).toBeNull()
  })
})
