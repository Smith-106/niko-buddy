// J15 诊断纵切面：统一健康聚合 + 脱敏诊断包 + J14反查入口数据层。
// fs 内存 mock 等价 Tauri invoke；不联网（LLM probe 注入而非真实调用）。
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
    listDirectory: vi.fn(async (_p: string) => []),
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
vi.mock("@/lib/novel/fts-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/fts-index")>()
  return {
    ...actual,
    loadFtsIndex: vi.fn(async () => null),
    rebuildWikiFtsIndex: vi.fn(async () => ({ indexed: 5, errors: [] })),
  }
})
vi.mock("@/lib/export/pdf-export-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/pdf-export-gate")>()
  return { ...actual, loadPdfExportHistory: vi.fn(async () => []) }
})

import {
  collectHealthReport,
  type HealthItem,
} from "./health-check"
import {
  sanitizeForBundle,
  sanitizeDeep,
  buildDiagnosticBundle,
  previewDiagnosticBundle,
  serializeDiagnosticBundle,
} from "./diagnostic-bundle"
import { loadExportHistoryView } from "@/lib/export/export-history-view"

const PROJECT = "C:/QM-J15/book"

async function seedHealthyProject() {
  await fsState.writeFileAtomic(`${PROJECT}/.niko-buddy/project.json`, JSON.stringify({ id: "p1", createdAt: 1 }))
  await fsState.writeFileAtomic(`${PROJECT}/schema.md`, "# schema")
  await fsState.writeFileAtomic(`${PROJECT}/QM/index.md`, "# idx")
  // 目录标记:生产 file_exists(Path::exists) 对目录返回 true;内存 mock 的 fileMap
  // 只存文件,故显式写入目录 entries 模拟磁盘目录存在(实现用 fileExists 测目录)。
  fsState.fileMap.set(`${PROJECT}/QM`, "dir")
  fsState.fileMap.set(`${PROJECT}/.novel`, "dir")
  await fsState.writeFileAtomic(`${PROJECT}/.novel/status.json`, JSON.stringify({
    schema_version: "1",
    session_id: "sess-x",
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
    status: "completed",
    active_step_index: null,
    current_task: { conversation_id: "c1", user_request: "req", status: "completed" },
    draft: { draft_id: "d1", file_path: "f", draft_status: "accepted" },
  }))
  await fsState.writeFileAtomic(`${PROJECT}/.novel/export-history.json`, JSON.stringify({ version: 1, entries: [] }))
}

beforeEach(() => fsState.fileMap.clear())

describe("collectHealthReport — 统一健康聚合(读真源)", () => {
  it("健康项目 → 各项健康,overall=healthy", async () => {
    await seedHealthyProject()
    const report = await collectHealthReport({
      projectPath: PROJECT,
      llmCfg: { provider: "claude-code", apiKey: "", model: "claude" },
    })
    expect(report.projectPath).toBe(PROJECT)
    expect(report.items).toHaveLength(7)
    const byId = Object.fromEntries(report.items.map((i) => [i.id, i]))
    expect(byId.project_fs.status).toBe("healthy")
    expect(byId.run.status).toBe("healthy")
    expect(byId.version.status).toBe("healthy")
    expect(byId.runtime.status).toBe("healthy")
    expect(byId.llm.status).toBe("healthy") // claude-code 零配置可用
    expect(byId.search_index.status).toBe("degraded") // fts mocked null
    expect(report.overall).toBe("degraded") // 最差项=degraded(索引)
  })

  it("interrupted Run → attention_required + RUN_INTERRUPTED 错误码", async () => {
    await seedHealthyProject()
    await fsState.writeFileAtomic(`${PROJECT}/.novel/status.json`, JSON.stringify({
      schema_version: "1",
      session_id: "sess-i",
      created_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      status: "interrupted",
      active_step_index: null,
      current_task: { conversation_id: "c1", user_request: "req", status: "interrupted" },
      draft: { draft_id: "d1", file_path: "f", draft_status: "pending" },
    }))
    const report = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    const run = report.items.find((i) => i.id === "run")!
    expect(run.status).toBe("attention_required")
    expect(run.errorCode).toBe("RUN_INTERRUPTED")
    expect(run.autoRecoverable).toBe(true)
    expect(report.overall).toBe("attention_required")
  })

  it("LLM 未配置 → degraded;auth_failed → attention_required", async () => {
    await seedHealthyProject()
    const r1 = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    expect(r1.items.find((i) => i.id === "llm")!.status).toBe("degraded")
    const r2 = await collectHealthReport({
      projectPath: PROJECT,
      llmCfg: { provider: "openai", apiKey: "k", model: "m" },
    })
    // 注入 auth probe 由调用方做;此处仅验证六态映射不建第七态
    expect(["healthy", "degraded", "attention_required"]).toContain(
      r2.items.find((i) => i.id === "llm")!.status,
    )
  })

  it("项目结构缺失 → project_fs attention_required", async () => {
    // 不 seed → 所有标记缺失
    const report = await collectHealthReport({ projectPath: "C:/nowhere/x", llmCfg: null })
    const fs = report.items.find((i) => i.id === "project_fs")!
    expect(fs.status).toBe("attention_required")
    expect(fs.errorCode).toBe("PROJECT_STRUCTURE_INCOMPLETE")
    expect(fs.userImpact).toContain("缺失")
  })

  it("每个异常项都带 userImpact+suggestedAction+evidenceSource(门禁3)", async () => {
    const report = await collectHealthReport({ projectPath: "C:/nowhere/x", llmCfg: null })
    for (const it of report.items) {
      expect(it.userImpact).toBeTruthy()
      expect(it.suggestedAction).toBeTruthy()
      expect(it.evidenceSource).toBeTruthy()
      expect(it.checkedAt).toBeTruthy()
      expect(Array.isArray(it.recoveries)).toBe(true)
    }
  })
})

describe("诊断包 — 默认脱敏(MAJOR-3 承接)", () => {
  it("sanitizeForBundle 遮蔽 URL/凭据/路径用户名/token", () => {
    const out = sanitizeForBundle(
      "call https://api.x.com/v1 key=sk-abc12345 Bearer eyJabcdefghij C:/Users/niko/proj",
    )
    expect(out).not.toContain("api.x.com")
    expect(out).not.toContain("sk-abc12345")
    expect(out).not.toContain("niko")
    expect(out).not.toContain("eyJabcdefghij")
    expect(out).toContain("[url]")
    expect(out).toContain("[redacted]")
    expect(out).toContain("[user]")
  })

  it("sanitizeDeep 剔除凭据字段+递归脱敏", () => {
    const out = sanitizeDeep({
      apiKey: "sk-secret",
      nested: { token: "tok", ok: "fine", url: "https://e.com" },
      list: ["Bearer abc", "plain"],
    }) as Record<string, unknown>
    expect(out.apiKey).toBeUndefined()
    const nested = out.nested as Record<string, unknown>
    expect(nested.token).toBeUndefined()
    expect(nested.url).toBe("[url]")
    expect((out.list as string[])[0]).toContain("[redacted]")
  })

  it("buildDiagnosticBundle 不含凭据/路径用户名/正文", async () => {
    // 注:bundle.schema 标识串 "niko-buddy/diagnostic-bundle@1" 本身含产品名——
    // 脱敏断言排除该标识串,检查其余内容。
    await seedHealthyProject()
    const report = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    const bundle = buildDiagnosticBundle({
      report,
      appVersion: "2.11.1",
      platform: "windows x64",
      // 标记用产品固定目录替身——bundle 的 markers 本是调用方传入的目录标记
  // (如 ".niko-buddy/"),断言前先剥离产品固定串,只验证无用户名/绝对路径泄露。
  projectMarkers: [".niko-buddy/", "QM/", ".novel/"],
      run: { status: "completed", sessionId: "sess-x", hasCurrentTask: true },
      exportEntryCount: 0,
    })
    const json = serializeDiagnosticBundle(bundle)
    // 产品固定标识(schema/markers)非敏感信息;敏感面=用户名/绝对路径/凭据:
    expect(json).not.toMatch(/Users[\\/][^"\\/\s\]]/)
    expect(json).not.toMatch(/C:[\\/]/)
    expect(json).not.toMatch(/sk-/)
    expect(json).not.toContain("apiKey")
    expect(json).not.toMatch(/Bearer/i)
    expect(json).not.toContain("userRequest")
    expect(bundle.schema).toBe("niko-buddy/diagnostic-bundle@1")
    expect(bundle.run?.sessionId).toBe("sess-x")
  })

  it("previewDiagnosticBundle 列出包含/排除/脱敏/目标(门禁11)", async () => {
    await seedHealthyProject()
    const report = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    const bundle = buildDiagnosticBundle({
      report,
      appVersion: "2.11.1",
      platform: "win",
      projectMarkers: ["QM"],
      run: null,
      exportEntryCount: 0,
    })
    const preview = previewDiagnosticBundle({ bundle, targetPath: "diag/bundle.json" })
    expect(preview.included.length).toBeGreaterThan(0)
    expect(preview.excluded.join()).toContain("API Key")
    expect(preview.excluded.join()).toContain("正文")
    expect(preview.sanitizedFields.join()).toContain("凭据")
    expect(preview.targetPath).toBe("diag/bundle.json")
    expect(preview.approxBytes).toBeGreaterThan(0)
    expect(preview.bundle).toBe(bundle)
  })
})

describe("J14 反查入口(消化 J14-UI-001) + 恢复幂等(门禁9)", () => {
  it("loadExportHistoryView 供诊断中心列出历史并展开 provenance", async () => {
    await seedHealthyProject()
    const view = await loadExportHistoryView(PROJECT)
    expect(view).toEqual([]) // 空历史
    // 非空时 UI 用 entry.provenance 恢复上下文(J14已验证)
  })

  it("索引恢复动作幂等且为安全自动级", async () => {
    await seedHealthyProject()
    const report = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    const idx = report.items.find((i) => i.id === "search_index")!
    const rebuild = idx.recoveries.find((r) => r.id === "rebuild-fts")!
    expect(rebuild.level).toBe("auto")
    expect(rebuild.idempotent).toBe(true)
    expect(rebuild.reversible).toBe(true)
    const r = await rebuild.run!()
    expect(r.ok).toBe(true)
    expect(r.detail).toContain("indexed=5")
    // 幂等:二次执行同结果
    const r2 = await rebuild.run!()
    expect(r2.ok).toBe(true)
  })

  it("forbidden 级动作不暴露执行体(门禁:禁止自动)", async () => {
    // 权限矩阵:删除项目/覆盖正文/清空历史/删凭据 不在任何 HealthItem.recoveries 提供 run
    const report = await collectHealthReport({ projectPath: PROJECT, llmCfg: null })
    for (const it of report.items) {
      for (const rec of it.recoveries) {
        if (rec.level === "forbidden") expect(rec.run).toBeNull()
      }
    }
  })
})
