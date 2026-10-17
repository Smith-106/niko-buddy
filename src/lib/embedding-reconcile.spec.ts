/**
 * embedding-reconcile.spec.ts — B4 重索引尾部对账的单元契约。
 *
 * 断言的核心不变量：
 *   1. 成功批次：`embedAllPages` 尾部把**实际写入的行集**作为 expected 交给
 *      `vector_run_startup_reconcile`（同源，不凭第二套推断删写）；
 *   2. 任一项读取/嵌入失败：跳过对账（清单不完整，不能让失败页被误判为陈旧页）；
 *   3. 对账命令失败：不吞错，经 `getLastReconcileOutcome()` 暴露（UI 可见）；
 *   4. `embedPage` 单页路径不触发对账（写入语义不变）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

const fsState = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))
const invokeMock = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => fsState)
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@/lib/tauri-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri-fetch")>()
  return {
    ...actual,
    getHttpFetch: async () => fetchMock,
    isFetchNetworkError: (err: unknown) =>
      err instanceof Error && /network|failed to fetch|load failed/i.test(err.message),
  }
})

import { embedAllPages, embedPage, getLastReconcileOutcome } from "./embedding"

function cfg(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:1234/v1/embeddings",
    apiKey: "sk-test",
    model: "text-embedding-model",
    ...overrides,
  }
}

function okJsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function wikiTree(projectPath: string): FileNode[] {
  return [
    {
      name: "entities",
      path: `${projectPath}/wiki/entities`,
      is_dir: true,
      children: [
        { name: "alpha.md", path: `${projectPath}/wiki/entities/alpha.md`, is_dir: false },
        { name: "beta.md", path: `${projectPath}/wiki/entities/beta.md`, is_dir: false },
      ],
    },
    { name: "index.md", path: `${projectPath}/wiki/index.md`, is_dir: false },
  ]
}

const REPORT = {
  upserted_pages: [],
  deleted_pages: ["gone-page"],
  unchanged_pages: ["alpha", "beta"],
  failed_pages: [],
  drifted: 0,
  pending_consumed: 0,
  skipped: false,
}

beforeEach(() => {
  fetchMock.mockReset()
  invokeMock.mockReset()
  fsState.readFile.mockReset()
  fsState.listDirectory.mockReset()
  fsState.listDirectory.mockResolvedValue(wikiTree("/P"))
  fsState.readFile.mockImplementation(async (path: string) =>
    String(path).endsWith("alpha.md")
      ? "---\ntitle: Alpha\n---\n\n# Alpha\n\n" + "alpha body ".repeat(120)
      : "---\ntitle: Beta\n---\n\n# Beta\n\n" + "beta body ".repeat(120),
  )
  fetchMock.mockImplementation(async () => okJsonResponse({ data: [{ embedding: [0.5, 0.25] }] }))
})

describe("embedAllPages 尾部对账（B4）", () => {
  it("成功批次：expected 与实际写入行集同源，report 暴露给 UI", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "vector_run_startup_reconcile") return { ...REPORT }
      return undefined
    })

    expect(await embedAllPages("/P", cfg())).toBe(2)

    const upserts = invokeMock.mock.calls.filter((call) => call[0] === "vector_upsert_chunks")
    const reconcile = invokeMock.mock.calls.find((call) => call[0] === "vector_run_startup_reconcile")
    expect(reconcile).toBeTruthy()
    const args = reconcile![1] as {
      projectPath: string
      expected: Array<{
        page_id: string
        chunk_index: number
        chunk_text: string
        heading_path: string
        embedding: number[]
      }>
    }
    expect(args.projectPath).toBe("/P")
    expect(args.expected.length).toBeGreaterThan(0)

    // 两个内容页都在清单内；每一行都带完整重投放载荷。
    const expectedByPage = new Map<string, number[]>()
    for (const row of args.expected) {
      expect(typeof row.page_id).toBe("string")
      expect(typeof row.chunk_index).toBe("number")
      expect(row.chunk_text.length).toBeGreaterThan(0)
      expect(typeof row.heading_path).toBe("string")
      expect(Array.isArray(row.embedding)).toBe(true)
      const bucket = expectedByPage.get(row.page_id) ?? []
      bucket.push(row.chunk_index)
      expectedByPage.set(row.page_id, bucket)
    }
    expect([...expectedByPage.keys()].sort()).toEqual(["alpha", "beta"])

    // 同源断言：每页 expected 的 chunk_index 集合 === 该页实际 upsert 的行集。
    for (const call of upserts) {
      const upsertArgs = call[1] as { pageId: string; chunks: Array<{ chunk_index: number }> }
      expect(expectedByPage.get(upsertArgs.pageId)).toEqual(
        upsertArgs.chunks.map((chunk) => chunk.chunk_index),
      )
    }
    const totalWritten = upserts.reduce(
      (sum, call) => sum + (call[1] as { chunks: unknown[] }).chunks.length,
      0,
    )
    expect(args.expected.length).toBe(totalWritten)

    const outcome = getLastReconcileOutcome()
    expect(outcome?.status).toBe("ran")
    if (outcome?.status === "ran") {
      expect(outcome.report.deleted_pages).toEqual(["gone-page"])
      expect(outcome.report.skipped).toBe(false)
    }
  })

  it("有页嵌入失败：跳过对账（清单不完整），失败页 id 暴露", async () => {
    fetchMock.mockImplementation(async () => new Response("no", { status: 500 }))

    expect(await embedAllPages("/P", cfg())).toBe(2)

    expect(invokeMock.mock.calls.some((call) => call[0] === "vector_run_startup_reconcile")).toBe(
      false,
    )
    const outcome = getLastReconcileOutcome()
    expect(outcome?.status).toBe("skipped")
    if (outcome?.status === "skipped") {
      expect(outcome.failedPageIds).toEqual(["alpha", "beta"])
    }
  })

  it("有页读取失败：跳过对账；其余页仍正常写入", async () => {
    fsState.readFile.mockImplementationOnce(async () => {
      throw new Error("EACCES")
    })

    expect(await embedAllPages("/P", cfg())).toBe(2)

    const upserts = invokeMock.mock.calls.filter((call) => call[0] === "vector_upsert_chunks")
    expect(upserts.map((call) => (call[1] as { pageId: string }).pageId)).toEqual(["beta"])
    expect(invokeMock.mock.calls.some((call) => call[0] === "vector_run_startup_reconcile")).toBe(
      false,
    )
    const outcome = getLastReconcileOutcome()
    expect(outcome?.status).toBe("skipped")
    if (outcome?.status === "skipped") {
      expect(outcome.failedPageIds).toEqual(["alpha"])
    }
  })

  it("对账命令失败：不吞错（failed 可见），重索引计数仍返回", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "vector_run_startup_reconcile") throw new Error("reconcile down")
      return undefined
    })

    expect(await embedAllPages("/P", cfg())).toBe(2)

    const outcome = getLastReconcileOutcome()
    expect(outcome?.status).toBe("failed")
    if (outcome?.status === "failed") {
      expect(outcome.error).toBe("reconcile down")
    }
  })

  it("对账跳过（Rust 空清单安全分支）时 report.skipped=true 原样透出", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "vector_run_startup_reconcile") {
        return { ...REPORT, skipped: true, deleted_pages: [], unchanged_pages: [] }
      }
      return undefined
    })

    await embedAllPages("/P", cfg())
    const outcome = getLastReconcileOutcome()
    expect(outcome?.status).toBe("ran")
    if (outcome?.status === "ran") {
      expect(outcome.report.skipped).toBe(true)
    }
  })

  it("禁用配置：不触发对账，旧结果被清空", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "vector_run_startup_reconcile") return { ...REPORT }
      return undefined
    })
    await embedAllPages("/P", cfg())
    expect(getLastReconcileOutcome()?.status).toBe("ran")

    expect(await embedAllPages("/P", cfg({ enabled: false }))).toBe(0)
    expect(getLastReconcileOutcome()).toBeNull()
  })

  it("embedPage 单页路径不触发对账（写入语义不变）", async () => {
    await embedPage("/P", "alpha", "Alpha", "---\ntitle: Alpha\n---\n\n# Alpha\n\n" + "body ".repeat(80), cfg())

    expect(invokeMock.mock.calls.some((call) => call[0] === "vector_upsert_chunks")).toBe(true)
    expect(invokeMock.mock.calls.some((call) => call[0] === "vector_run_startup_reconcile")).toBe(
      false,
    )
    expect(getLastReconcileOutcome()).toBeNull()
  })
})
