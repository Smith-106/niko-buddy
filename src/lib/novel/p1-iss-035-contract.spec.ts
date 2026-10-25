/**
 * ISS-20260709-035：rawData Record<string,any> 改类型化 DataSource 契约。
 *
 * 类型编译保证：ContextRawData 继承 Record<string, unknown> 索引签名 ——
 * 已知键显式声明（全部可选），DataSourceRegistry.loadAll 产出可直接收敛；
 * loadAll → engine 调用点经单次显式 cast（调用点注释）。
 * 等价断言：未知/非 string 载荷仍收窄为 ""/[]（与 any 时代字节级一致）。
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { ContextRawData } from "./context-data-source"
import { normalizeRawSnapshots, resolveSummaryBasics } from "./context-engine"

describe("ISS-20260709-035 类型化 DataSource 契约 ContextRawData", () => {
  it("契约声明已知键（含快照视图），不再是裸 Record<string,any>", () => {
    const source = readFileSync(new URL("./context-data-source.ts", import.meta.url), "utf8")
    expect(source).toMatch(/export interface ContextRawData/)
    for (const key of [
      "snapshots?:",
      "outline?:",
      "chapterOutline?:",
      "recentChapterContents?:",
      "fallbackRecentSummaries?:",
      "revisionFeedback?:",
      "cognitionText?:",
    ]) {
      expect(source).toContain(key)
    }
    expect(source).not.toMatch(/Record<string,\s*any>/)
  })

  it("类型编译保证：ContextRawData 可赋值给 Record<string, unknown>（调用方兼容）", () => {
    const raw: ContextRawData = { outline: "o", snapshots: { timeline: "t" } }
    const asRecord: Record<string, unknown> = raw
    expect(asRecord["outline"]).toBe("o")
    // 未知扩展键仍可携带（索引签名保留）
    const extended: ContextRawData = { ...raw, someFutureSource: 42 }
    expect(extended["someFutureSource"]).toBe(42)
  })

  it("等价：非 string/缺失载荷收窄为 \"\"/[]（any 时代语义保留）", () => {
    const basics = resolveSummaryBasics(
      {
        fallbackRecentSummaries: 123,
        fallbackPreviousEnding: null,
        recentChapterContents: "not-an-array",
      } as unknown as ContextRawData,
      normalizeRawSnapshots({} as ContextRawData),
    )
    expect(basics.recentSummaries).toEqual([])
    expect(basics.previousChapterEnding).toBe("")
    expect(basics.recentChapterContents).toEqual([])
  })
})
