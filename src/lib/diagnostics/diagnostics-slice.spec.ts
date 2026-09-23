// J15 纵切面：异常 → 诊断 → 恢复 → 复检 → 脱敏诊断包（首轮失败基线证伪）。
// 构造三重异常（interrupted Run + source_missing 导出 + 索引损坏），
// 走 collectHealthReport → 恢复动作 → 复检 → 导出脱敏包全链。
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  return {
    fileMap,
    createDirectory: vi.fn(async (_p: string) => {}),
    fileExists: vi.fn(async (p: string) => fileMap.has(p)),
    readFile: vi.fn(async (p: string) => {
      const c = fileMap.get(p)
      if (c === undefined) throw new Error(`ENOENT: ${p}`)
      return c
    }),
    writeFileAtomic: vi.fn(async (p: string, c: string) => {
      fileMap.set(p, c)
    }),
    listDirectory: vi.fn(async (p: string) => {
      // wiki 目录列出 1 个 md，供 rebuildWikiFtsIndex 真实重建。
      if (p.endsWith("/wiki")) {
        return [{ name: "intro.md", path: `${p}/intro.md`, is_dir: false }]
      }
      return []
    }),
  }
})
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: fsState.createDirectory,
    fileExists: fsState.fileExists,
    readFile: fsState.readFile,
    writeFileAtomic: fsState.writeFileAtomic,
    listDirectory: fsState.listDirectory,
  }
})
vi.mock("@/lib/platform", () => ({ isTauri: () => true }))
// 注意：不 mock pdf-export-gate——纵切面要求真实 loadPdfExportHistory 读种子
// export-history.json（含 sourceMissing 条目），验证 history 项 degraded。

import { collectHealthReport } from "./health-check"
import {
  buildDiagnosticBundle,
  previewDiagnosticBundle,
  serializeDiagnosticBundle,
} from "./diagnostic-bundle"

const PROJECT = "C:/QM-J15-slice/book"

function statusJson(status: string, taskStatus: string) {
  return JSON.stringify({
    schema_version: "1",
    session_id: "sess-slice",
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
    status,
    active_step_index: null,
    current_task: { conversation_id: "c1", user_request: "req", status: taskStatus },
    draft: { draft_id: "d1", file_path: "f", draft_status: "pending" },
  })
}

/** 三重异常种子：中断 Run + 源缺失导出 + 损坏索引。 */
async function seedFailureState() {
  fsState.fileMap.set(`${PROJECT}/QM`, "dir")
  fsState.fileMap.set(`${PROJECT}/.novel`, "dir")
  fsState.fileMap.set(`${PROJECT}/.niko-buddy/project.json`, JSON.stringify({ id: "p1" }))
  fsState.fileMap.set(`${PROJECT}/schema.md`, "# schema")
  // 1) interrupted Run
  fsState.fileMap.set(`${PROJECT}/.novel/status.json`, statusJson("interrupted", "interrupted"))
  // 2) 源缺失导出（userRequest 内藏凭据形态串——验证包内绝不出现）
  fsState.fileMap.set(`${PROJECT}/.novel/export-history.json`, JSON.stringify({
    version: 1,
    entries: [
      {
        id: "out/ch1.pdf::deadbeef",
        target: "out/ch1.pdf",
        chapterPath: "QM/chapters/chapter-007.md",
        contentDigest: "deadbeef",
        confirmedDigest: "deadbeef",
        chapterNumber: 7,
        chapterTitle: "第七章",
        sessionId: "sess-slice",
        conversationId: "c1",
        userRequest: "请导出第七章 Bearer sk-slice-secret-00112233445566778899",
        pages: 5,
        bytesWritten: 500,
        font: "cjk",
        exportedAt: "2026-09-23T00:00:00Z",
        sourceMissing: true,
      },
    ],
  }))
  // 3) 损坏的 FTS 索引（loadFtsIndex→null → degraded）
  fsState.fileMap.set(`${PROJECT}/.niko-buddy/fts-index.json`, "CORRUPT{{{not-json")
  // 重建语料：wiki 下 1 个 md
  fsState.fileMap.set(`${PROJECT}/wiki/intro.md`, "# 开篇\n正文内容。")
}

beforeEach(() => fsState.fileMap.clear())

describe("J15 纵切面：异常→诊断→恢复→复检→脱敏包", () => {
  it("全链：三重异常可诊断、可恢复（索引）、复检更新、包脱敏", async () => {
    await seedFailureState()

    // ── 1) 诊断：三重异常各就各位 ──
    const diag = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    const byId = Object.fromEntries(diag.items.map((i) => [i.id, i]))
    expect(byId.run.status).toBe("attention_required")
    expect(byId.run.errorCode).toBe("RUN_INTERRUPTED")
    expect(byId.history.status).toBe("degraded")
    expect(byId.history.errorCode).toBe("HISTORY_MISSING_SOURCE_OR_OUTPUT")
    expect(byId.search_index.status).toBe("degraded")
    expect(byId.search_index.errorCode).toBe("INDEX_STALE_OR_MISSING")
    expect(diag.overall).toBe("attention_required")

    // ── 2) 恢复：索引重建（auto 幂等）+ 会话恢复（用户打开项目→completed） ──
    const rebuild = byId.search_index.recoveries.find((r) => r.id === "rebuild-fts")!
    expect(rebuild.level).toBe("auto")
    const rr = await rebuild.run!()
    expect(rr.ok).toBe(true)
    expect(rr.detail).toContain("indexed=1")
    // 会话恢复 = 用户打开项目继续写作（status 回到 running；markSessionInterrupted 语义已生效）
    fsState.fileMap.set(`${PROJECT}/.novel/status.json`, statusJson("running", "running"))

    // ── 3) 复检：run/index 更新；history 保持 degraded（源缺失证据不删） ──
    const re = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    const reById = Object.fromEntries(re.items.map((i) => [i.id, i]))
    expect(reById.run.status).toBe("healthy")
    expect(reById.search_index.status).toBe("healthy")
    expect(reById.history.status).toBe("degraded") // 导出证据保留，门禁6/8
    expect(re.overall).toBe("degraded") // 最差项=历史源缺失
    expect(re.checkedAt).not.toBe(diag.checkedAt)

    // ── 4) 脱敏诊断包：preview → serialize → 无泄漏断言 ──
    const bundle = buildDiagnosticBundle({
      report: re,
      appVersion: "2.11.1",
      platform: "windows x64",
      projectMarkers: [".niko-buddy/", "QM/", ".novel/"],
      run: { status: "running", sessionId: "sess-slice", hasCurrentTask: true },
      exportEntryCount: 1,
    })
    expect(bundle.historyCounts.source_missing).toBe(1)
    const preview = previewDiagnosticBundle({ bundle, targetPath: "diag/bundle.json" })
    expect(preview.included.length).toBeGreaterThan(0)
    expect(preview.excluded.join()).toContain("API Key")
    expect(preview.sanitizedFields.length).toBeGreaterThan(0)
    const json = serializeDiagnosticBundle(bundle)
    // 凭据形态串（藏在 userRequest）绝不入包
    expect(json).not.toContain("sk-slice-secret")
    expect(json).not.toMatch(/Bearer/i)
    expect(json).not.toContain("userRequest")
    // 项目根绝对路径被掩码
    expect(json).not.toContain("C:/QM-J15-slice")
    expect(json).not.toMatch(/C:[\\/]/)
    // 计数非内容：source_missing=1 但无章节正文
    expect(json).toContain("source_missing")
    expect(json).not.toContain("正文内容")
  })
})
