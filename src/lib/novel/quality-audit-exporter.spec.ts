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

    // Format markdown for non-ready project
    const md = formatQualityAuditMarkdown(report)
    expect(md).toContain("需整改")
  })

  it("handles fallback default title and various grade boundaries", () => {
    // Test default title and Grade AA
    const reportAA = buildIsoQualityAuditReport({
      projectPath: "c:/novels/untitled",
      chapterCount: 10,
      gatePassRate: 85,
      consistencyIncidentCount: 0,
      antiAiClichéRate: 3.0,
    })
    expect(reportAA.projectInfo.title).toBe("Niko Buddy Novel Project")
    expect(reportAA.verdict.grade).toBe("AA")

    // Test Grade A (incidents = 1)
    const reportA = buildIsoQualityAuditReport({
      projectPath: "c:/novels/untitled",
      chapterCount: 10,
      gatePassRate: 95,
      consistencyIncidentCount: 1,
    })
    expect(reportA.verdict.grade).toBe("A")

    // Test Grade B (incidents = 4)
    const reportB = buildIsoQualityAuditReport({
      projectPath: "c:/novels/untitled",
      chapterCount: 10,
      gatePassRate: 60,
      consistencyIncidentCount: 4,
    })
    expect(reportB.verdict.grade).toBe("B")

    // Test Grade C (incidents = 15)
    const reportC = buildIsoQualityAuditReport({
      projectPath: "c:/novels/untitled",
      chapterCount: 10,
      gatePassRate: 40,
      consistencyIncidentCount: 15,
    })
    expect(reportC.verdict.grade).toBe("C")

    // Test minimal inputs with default gatePassRate and antiAiClichéRate
    const reportMinimal = buildIsoQualityAuditReport({
      projectPath: "c:/novels/minimal",
      chapterCount: 1,
    })
    expect(reportMinimal.iso25059AiMetrics.functionalCorrectness).toBe(100)
    expect(reportMinimal.iso25059AiMetrics.societalEthicalRiskMitigation).toBe(95)
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
    expect(md).toContain("具备正式交付/出版标准")
  })
})
