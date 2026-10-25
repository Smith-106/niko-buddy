/**
 * ISS-20260713-004：executeIngestWrites 操作 chat store UI 状态改 SoC。
 *
 * 分层：buildIngestWritePlan（纯：累积文本 → 写计划）/
 * buildIngestWriteSummary（纯：落盘结果 → 系统文案）只返回值；
 * UI 更新（store 消息）归 wrapper 调用方编排。
 *
 * 等价断言：写计划路径拼接/log 追加判定/系统文案与原内联逻辑字节级一致。
 */
import { describe, expect, it } from "vitest"
import { buildIngestWritePlan, buildIngestWriteSummary } from "./ingest"

const SAMPLE = [
  "---FILE: wiki/a.md---",
  "# A",
  "正文",
  "---END FILE---",
  "---FILE: wiki/log.md---",
  "log entry",
  "---END FILE---",
  "---FILE: wiki/sub/log.md---",
  "sub log entry",
  "---END FILE---",
].join("\n")

describe("ISS-20260713-004 executeIngestWrites SoC", () => {
  it("buildIngestWritePlan 解析块并判定 log 追加（等价原内联循环）", () => {
    const plan = buildIngestWritePlan("E:/Proj", SAMPLE)
    expect(plan.warnings).toEqual([])
    expect(plan.operations.map((op) => op.relativePath)).toEqual([
      "wiki/a.md",
      "wiki/log.md",
      "wiki/sub/log.md",
    ])
    expect(plan.operations.map((op) => op.fullPath)).toEqual([
      "E:/Proj/wiki/a.md",
      "E:/Proj/wiki/log.md",
      "E:/Proj/wiki/sub/log.md",
    ])
    // 原判定：relativePath === "wiki/log.md" || endsWith("/log.md")
    expect(plan.operations.map((op) => op.isLogAppend)).toEqual([false, true, true])
    expect(plan.operations[0]?.content).toContain("正文")
  })

  it("buildIngestWritePlan 空输入 → 空操作（等价未写入分支前置）", () => {
    const plan = buildIngestWritePlan("E:/Proj", "no file blocks here")
    expect(plan.operations).toEqual([])
  })

  it("buildIngestWriteSummary 文案与原内联两分支字节级一致", () => {
    expect(buildIngestWriteSummary(["E:/Proj/wiki/a.md", "E:/Proj/wiki/log.md"])).toBe(
      "已写入知识库文件：\n- E:/Proj/wiki/a.md\n- E:/Proj/wiki/log.md",
    )
    expect(buildIngestWriteSummary([])).toBe(
      "未写入任何文件。LLM 响应中未包含有效的文件块。",
    )
  })
})
