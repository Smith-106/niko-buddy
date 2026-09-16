/**
 * run-event-ledger-store.spec — 波2-A EB-4 账本持久化测试（内存 fake deps）。
 * 覆盖：缺失文件 → 空账本 / append 往返相等 / seq 严格单调 / eventId 缺省
 * 派生唯一 / 损坏行 fail-loud 含行号 / 空行容忍 / store 落盘后门事件覆盖率。
 */
import { describe, expect, it } from "vitest"
import { checkGateEventCoverage, recordGateRunEvents } from "./run-event-ledger"
import {
  RUN_EVENTS_FILENAME,
  appendRunEventToStore,
  appendRunEventsToStore,
  createFsRunEventLedgerStoreDeps,
  loadRunEventLedgerStore,
  runEventsPath,
  type RunEventLedgerStoreDeps,
} from "./run-event-ledger-store"

/** 内存 fake deps：Map 存文件；appendText = 读改写（与生产语义一致）。 */
function memoryDeps(): { deps: RunEventLedgerStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    deps: {
      readText: async (path) => files.get(path) ?? null,
      appendText: async (path, text) => {
        files.set(path, (files.get(path) ?? "") + text)
      },
    },
  }
}

const PP = "C:/proj/demo"
const TS = "2026-09-16T00:00:00.000Z"

describe("runEventsPath（路径契约）", () => {
  it("恒为 {projectPath}/.novel/run-events.jsonl", () => {
    expect(runEventsPath("C:/proj")).toBe(`C:/proj/.novel/${RUN_EVENTS_FILENAME}`)
    expect(RUN_EVENTS_FILENAME).toBe("run-events.jsonl")
  })
})

describe("loadRunEventLedgerStore（重建）", () => {
  it("文件缺失 → 空账本", async () => {
    const { deps } = memoryDeps()
    const ledger = await loadRunEventLedgerStore(deps, PP)
    expect(ledger.events).toHaveLength(0)
    expect(ledger.schemaVersion).toBe("run-event-ledger/1.0")
  })

  it("append 后 load 往返相等（seq 单调 + payload 保真）", async () => {
    const { deps } = memoryDeps()
    const first = await appendRunEventToStore(deps, PP, {
      eventId: "gate-run:0:consistency",
      ts: TS,
      kind: "gate-run",
      actor: "system",
      payload: { gate: "consistency", status: "fail" },
    })
    const second = await appendRunEventToStore(deps, PP, {
      eventId: "retrieval:1",
      ts: TS,
      kind: "retrieval",
      actor: "writer",
      modelId: "model-a",
    })
    expect(first.events).toHaveLength(1)
    expect(second.events).toHaveLength(2)
    const reloaded = await loadRunEventLedgerStore(deps, PP)
    expect(reloaded.events).toEqual(second.events)
    expect(second.events[0]?.seq).toBe(0)
    expect(second.events[1]?.seq).toBe(1)
  })

  it("eventId 缺省确定性派生 ${kind}:${seq} 且唯一；显式 eventId 保留", async () => {
    const { deps } = memoryDeps()
    const a = await appendRunEventToStore(deps, PP, { ts: TS, kind: "generate", actor: "writer" })
    const b = await appendRunEventToStore(deps, PP, { ts: TS, kind: "generate", actor: "writer" })
    expect(a.events[0]?.eventId).toBe("generate:0")
    expect(b.events[1]?.eventId).toBe("generate:1")
    const c = await appendRunEventToStore(deps, PP, { ts: TS, kind: "error", actor: "system", eventId: "custom-1" })
    expect(c.events[2]?.eventId).toBe("custom-1")
  })

  it("非法 JSON 行 → fail-loud 含行号（不静默丢事件）", async () => {
    const { deps, files } = memoryDeps()
    files.set(runEventsPath(PP), '{"seq":0,"eventId":"e0","ts":"t","kind":"stage","actor":"system"}\n{broken\n')
    await expect(loadRunEventLedgerStore(deps, PP)).rejects.toThrow(/第 2 行非法 JSON/)
  })

  it("schema 违反行 → fail-loud 含行号（seq 断裂等契约违反）", async () => {
    const { deps, files } = memoryDeps()
    files.set(
      runEventsPath(PP),
      '{"seq":0,"eventId":"e0","ts":"t","kind":"stage","actor":"system"}\n' +
        '{"seq":0,"eventId":"e1","ts":"t","kind":"stage","actor":"system"}\n',
    )
    await expect(loadRunEventLedgerStore(deps, PP)).rejects.toThrow(/第 2 行契约违反/)
  })

  it("空行容忍（尾部换行 / 中间空行均跳过）", async () => {
    const { deps, files } = memoryDeps()
    files.set(
      runEventsPath(PP),
      '\n{"seq":0,"eventId":"e0","ts":"t","kind":"stage","actor":"system"}\n\n',
    )
    const ledger = await loadRunEventLedgerStore(deps, PP)
    expect(ledger.events).toHaveLength(1)
  })
})

describe("appendRunEventsToStore（批量）", () => {
  it("批量 seq 连续 + 单行落盘 + recordGateRunEvents 覆盖率 1", async () => {
    const { deps } = memoryDeps()
    // 先内存构建一次门控运行事件（含 skipped——短路也是可审计事件）
    const outcomes = [
      { gate: "consistency" as const, status: "fail" as const, findingsCount: 1, escalatedCount: 0, score: null },
      { gate: "anti_ai" as const, status: "skipped" as const, findingsCount: 0, escalatedCount: 0, score: null },
      { gate: "quality" as const, status: "skipped" as const, findingsCount: 0, escalatedCount: 0, score: null },
    ]
    const recorded = recordGateRunEvents(
      await Promise.resolve(loadRunEventLedgerStore(deps, PP)),
      outcomes,
      { ts: TS, replayId: "replay-1", evidenceRefs: ["finding:world-hard:ws-a:0"] },
    )
    const stored = await appendRunEventsToStore(deps, PP, recorded.events)
    expect(stored.events).toHaveLength(3)
    const reloaded = await loadRunEventLedgerStore(deps, PP)
    expect(reloaded.events.map((e) => e.eventId)).toEqual([
      "gate-run:0:consistency",
      "gate-run:1:anti_ai",
      "gate-run:2:quality",
    ])
    const coverage = checkGateEventCoverage(outcomes, reloaded)
    expect(coverage.rate).toBe(1)
    expect(coverage.uncoveredGates).toHaveLength(0)
  })
})

describe("createFsRunEventLedgerStoreDeps（默认 deps 结构守卫）", () => {
  it("readText 缺文件 → null（不抛）；appendText 恒定义（结构面）", async () => {
    const deps = createFsRunEventLedgerStoreDeps()
    expect(typeof deps.appendText).toBe("function")
    // Tauri 环境外 readFile invoke 不可用 → 缺文件语义分支返回 null
    const missing = await deps.readText("C:/definitely/not/exist.jsonl")
    expect(missing).toBeNull()
  })
})