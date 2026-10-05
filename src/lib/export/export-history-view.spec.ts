import { describe, it, expect, vi } from "vitest"
import {
  resolveExportProvenance,
  loadExportHistoryView,
  type ExportHistoryStatus,
} from "./export-history-view"
import type { PdfExportHistoryEntry } from "./pdf-export-gate"

vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(async () => false),
  readFile: vi.fn(async () => {
    throw new Error("not found")
  }),
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async () => {}),
}))
vi.mock("@/lib/export/pdf-export-gate", async (orig) => {
  const mod = await orig<typeof import("./pdf-export-gate")>()
  return { ...mod, loadPdfExportHistory: vi.fn(async () => []) }
})
import { loadPdfExportHistory } from "./pdf-export-gate"
const mockHistory = vi.mocked(loadPdfExportHistory)

const PP = "C:/proj"

function entry(over: Partial<PdfExportHistoryEntry> = {}): PdfExportHistoryEntry {
  return {
    id: "exports/ch1.pdf::abc123",
    target: "exports/ch1.pdf",
    chapterPath: "QM/chapters/chapter-001.md",
    contentDigest: "abc123",
    confirmedDigest: "abc123",
    chapterNumber: 1,
    chapterTitle: "第一章",
    sessionId: "sess-1",
    conversationId: "conv-1",
    userRequest: "写第一章",
    pages: 3,
    bytesWritten: 1000,
    font: "cjk",
    exportedAt: "2026-09-23T10:00:00Z",
    ...over,
  }
}

describe("resolveExportProvenance — J14 反向溯源", () => {
  it("available: 源+产物都在 → 完整上下文", async () => {
    const p = await resolveExportProvenance(PP, entry(), {
      chapterFileExists: async () => true,
      outputFileExists: async () => true,
    })
    expect(p.status).toBe("available")
    expect(p.exportId).toBe("exports/ch1.pdf::abc123")
    expect(p.confirmedVersion.confirmedDigest).toBe("abc123")
    expect(p.run.sessionId).toBe("sess-1")
    expect(p.run.resolvable).toBe(true)
    expect(p.sourceAsset.reachable).toBe(true)
    expect(p.output.exists).toBe(true)
    expect(p.projectPath).toBe(PP)
  })

  it("source_missing: 记录标记 sourceMissing → 派生 source_missing", async () => {
    const p = await resolveExportProvenance(
      PP,
      entry({ sourceMissing: true }),
      {
        chapterFileExists: async () => false,
        outputFileExists: async () => true,
      },
    )
    expect(p.status).toBe("source_missing")
    expect(p.sourceAsset.reachable).toBe(false)
  })

  it("source_missing: 未标记但源文件实时不存在 → 派生 source_missing", async () => {
    const p = await resolveExportProvenance(PP, entry({ chapterNumber: 99 }), {
      chapterFileExists: async () => false,
      outputFileExists: async () => true,
    })
    expect(p.status).toBe("source_missing")
  })

  it("重命名重连: 记录路径失效但 chapter_number 在 QM/chapters 找回 → available", async () => {
    const exists = async (abs: string) =>
      abs === `${PP}/QM/chapters/chapter-001.md` ? false : true // 记录路径失效
    const reconnect = async (abs: string) => {
      // QM/chapters/chapter-001.md 不存在,但 chapter-001 在别处? 模拟重命名:
      // chapter-001.md 已被重命名,但 chapter_number=1 匹配候选仍命中 chapter-001.md
      return abs.endsWith("chapter-001.md")
    }
    const p = await resolveExportProvenance(PP, entry({ chapterPath: "QM/chapters/old-name.md" }), {
      chapterFileExists: reconnect,
      outputFileExists: async () => true,
    })
    expect(p.sourceAsset.resolvedPath).toBe("QM/chapters/chapter-001.md")
    expect(p.sourceAsset.reachable).toBe(true)
    expect(p.status).toBe("available")
  })

  it("output_missing: 源在但 PDF 产物缺失 → output_missing", async () => {
    const p = await resolveExportProvenance(PP, entry(), {
      chapterFileExists: async () => true,
      outputFileExists: async () => false,
    })
    expect(p.status).toBe("output_missing")
    expect(p.sourceAsset.reachable).toBe(true)
    expect(p.output.exists).toBe(false)
  })

  it("invalid: 字段残缺 → invalid,不崩溃", async () => {
    const p = await resolveExportProvenance(
      PP,
      entry({ id: "", confirmedDigest: "" }),
      { chapterFileExists: async () => false, outputFileExists: async () => false },
    )
    expect(p.status).toBe("invalid")
    expect(p.run.resolvable).toBe(false)
  })

  it("sessionId 空串 → run.resolvable=false(不伪造Run身份)", async () => {
    const p = await resolveExportProvenance(
      PP,
      entry({ sessionId: "", conversationId: "", userRequest: "" }),
      { chapterFileExists: async () => true, outputFileExists: async () => true },
    )
    expect(p.run.resolvable).toBe(false)
    expect(p.status).toBe("available") // Run 溯源缺失不改变资产状态
  })
})

describe("loadExportHistoryView — 派生视图(重启一致)", () => {
  it("空历史 → 空视图", async () => {
    mockHistory.mockResolvedValueOnce([])
    const v = await loadExportHistoryView(PP)
    expect(v).toEqual([])
  })

  it("多条 → 按 exportedAt 倒序 + 各带派生状态", async () => {
    mockHistory.mockResolvedValueOnce([
      entry({ id: "e1", exportedAt: "2026-09-20T10:00:00Z" }),
      entry({ id: "e2", exportedAt: "2026-09-23T10:00:00Z", sourceMissing: true }),
    ])
    const v = await loadExportHistoryView(PP, {
      chapterFileExists: async () => true,
      outputFileExists: async () => true,
    })
    expect(v).toHaveLength(2)
    expect(v[0].entry.id).toBe("e2") // 最新在前
    expect(v[0].status).toBe("source_missing")
    expect(v[1].entry.id).toBe("e1")
    expect(v[1].status).toBe("available")
  })

  it("同一记录两次加载(模拟重启) → 派生一致", async () => {
    mockHistory.mockResolvedValue([entry()])
    const deps = {
      chapterFileExists: async () => true,
      outputFileExists: async () => false,
    }
    const a = await loadExportHistoryView(PP, deps)
    const b = await loadExportHistoryView(PP, deps)
    expect(a[0].status).toBe("output_missing")
    expect(b[0].status).toBe("output_missing")
    expect(a[0].provenance.exportId).toBe(b[0].provenance.exportId)
  })
})

describe("状态枚举完备性", () => {
  it("ExportHistoryStatus 含建议模型全部值", () => {
    const all: ExportHistoryStatus[] = [
      "available",
      "source_missing",
      "output_missing",
      "partially_available",
      "invalid",
    ]
    expect(all).toHaveLength(5)
  })
})
