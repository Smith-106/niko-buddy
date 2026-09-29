import { describe, expect, it } from "vitest"
import {
  buildIsoQualityAuditReport,
  formatQualityAuditMarkdown,
} from "./quality-audit-exporter"

describe("quality-audit-exporter (ISO 25010 & ISO 25059 Quality Models)", () => {
  it("builds a high-grade ISO report for clean project", () => {
    const report = buildIsoQualityAuditReport({
      novelTitle: "全域纪元",
      projectPath: "c:/novels/epoch",
      chapterCount: 15,
      gatePassRate: 100,
      consistencyIncidentCount: 0,
    })

    expect(report.standard).toBe("ISO/IEC 25010:2023 & ISO/IEC 25059:2023")
    expect(report.iso25010Scores.overallAverage).toBeGreaterThanOrEqual(97)
    expect(report.iso25059AiMetrics.intervenability).toBe(100)
    expect(report.verdict.grade).toBe("AAA")
    expect(report.verdict.passedAllHardGates).toBe(true)
    expect(report.verdict.readyForPublishing).toBe(true)
  })

  it("downgrades report when consistency incidents occur", () => {
    const report = buildIsoQualityAuditReport({
      novelTitle: "修仙录",
      projectPath: "c:/novels/xiuxian",
      chapterCount: 5,
      gatePassRate: 75,
      consistencyIncidentCount: 3,
    })

    expect(report.verdict.passedAllHardGates).toBe(false)
    expect(report.verdict.readyForPublishing).toBe(false)
    expect(report.verdict.summary).toContain("存在 3 项一致性告警")
  })

  it("formats audit report as readable markdown with ISO 15289 compliant structure", () => {
    const report = buildIsoQualityAuditReport({
      novelTitle: "星海征途",
      projectPath: "c:/novels/star-voyage",
      chapterCount: 30,
      gatePassRate: 98,
      consistencyIncidentCount: 0,
    })

    const md = formatQualityAuditMarkdown(report)
    expect(md).toContain("# Niko Buddy 作品质量与 AI 系统合规审计报告")
    expect(md).toContain("星海征途")
    expect(md).toContain("ISO/IEC 25010:2023")
    expect(md).toContain("ISO/IEC 25059:2023")
    expect(md).toContain("Draft-first 沙箱隔离，零脏数据落盘")
  })
})
