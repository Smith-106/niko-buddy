/** @vitest-environment jsdom */
/**
 * 向量库健康卡片的补测（statements 100% 专项）：
 * 覆盖「无项目 / 统计失败 / 压缩两条提示 / 对账两条提示 / 刷新 / 异常提示」等
 * 既有 vector-health-card.spec.tsx 未触达的路径。既有 spec 保持原样，本文件只做增补。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
  countVectorChunks,
  dropLegacyVectorTable,
  legacyVectorRowCount,
  triggerIdleCompaction,
} from "@/lib/embedding"
import { invoke } from "@tauri-apps/api/core"
import { VectorHealthCard } from "./vector-health-card"

/** 可切换的项目：null 用于覆盖「无项目」早退路径。 */
const store = vi.hoisted(() => ({
  project: { path: "/p/book" } as { path: string } | null,
}))

// 与项目惯例一致：返回 defaultValue 并做 {{var}} 插值，断言中文可见文案
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dv = typeof opts?.defaultValue === "string" ? opts.defaultValue : key
      return dv.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ""))
    },
  }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (sel: (s: { project: typeof store.project }) => unknown) => sel({ project: store.project }),
}))

vi.mock("@/lib/embedding", () => ({
  countVectorChunks: vi.fn(async () => 7),
  legacyVectorRowCount: vi.fn(async () => 0),
  triggerIdleCompaction: vi.fn(),
  dropLegacyVectorTable: vi.fn(async () => {}),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

const countMock = vi.mocked(countVectorChunks)
const legacyMock = vi.mocked(legacyVectorRowCount)
const compactMock = vi.mocked(triggerIdleCompaction)
const dropMock = vi.mocked(dropLegacyVectorTable)
const invokeMock = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  store.project = { path: "/p/book" }
  countMock.mockResolvedValue(11)
  legacyMock.mockResolvedValue(3)
  compactMock.mockResolvedValue({ chunks_compacted: 5, old_fragments_cleared: 2 })
  dropMock.mockResolvedValue(undefined)
  invokeMock.mockResolvedValue({ skipped: false })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("VectorHealthCard 边界路径", () => {
  it("无项目：不查询向量库、摘要显示占位符、三个运维按钮不可用", async () => {
    store.project = null
    render(<VectorHealthCard />)
    await waitFor(() => expect(screen.getByTestId("vector-health-card")).toBeTruthy())

    expect(countMock).not.toHaveBeenCalled()
    expect(legacyMock).not.toHaveBeenCalled()
    expect(screen.getByText("Chunk总数 — · 旧表残留 —")).toBeTruthy()
    for (const name of [/立即压缩/, /对账校验/, /清理旧版残留/, /刷新/]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it("无项目时即使派发点击也不触发任何运维调用（早退守卫）", async () => {
    store.project = null
    render(<VectorHealthCard />)
    await waitFor(() => expect(screen.getByTestId("vector-health-card")).toBeTruthy())

    for (const name of [/立即压缩/, /对账校验/, /清理旧版残留/, /刷新/]) {
      fireEvent.click(screen.getByRole("button", { name }))
    }
    expect(compactMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(dropMock).not.toHaveBeenCalled()
    expect(countMock).not.toHaveBeenCalled()
  })

  it("统计失败：两个数值都退回占位符，不残留旧数字", async () => {
    countMock.mockRejectedValue(new Error("db-locked"))
    render(<VectorHealthCard />)
    expect(await screen.findByText("Chunk总数 — · 旧表残留 —")).toBeTruthy()
    expect(screen.queryByText(/Chunk总数 11/)).toBeNull()
  })

  it("立即压缩：进行中显示压缩中文案，完成后提示合并数量", async () => {
    let release: (v: { chunks_compacted: number; old_fragments_cleared: number }) => void = () => {}
    compactMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 11/)

    fireEvent.click(screen.getByRole("button", { name: /立即压缩/ }))
    expect(await screen.findByText("压缩中…")).toBeTruthy()
    expect((screen.getByRole("button", { name: /压缩中…/ }) as HTMLButtonElement).disabled).toBe(true)

    release({ chunks_compacted: 5, old_fragments_cleared: 2 })
    expect(await screen.findByText("压缩完成，已合并 5 个 chunk")).toBeTruthy()
    expect(screen.queryByText("压缩中…")).toBeNull()
  })

  it("立即压缩：引擎无压缩结果时退化为「压缩完成」", async () => {
    compactMock.mockResolvedValue(null)
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 11/)
    fireEvent.click(screen.getByRole("button", { name: /立即压缩/ }))
    expect(await screen.findByText("压缩完成")).toBeTruthy()
  })

  it("对账校验：未跳过时提示对账完成", async () => {
    invokeMock.mockResolvedValue({ skipped: false })
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 11/)
    fireEvent.click(screen.getByRole("button", { name: /对账校验/ }))
    expect(await screen.findByText("对账完成")).toBeTruthy()
    expect(invokeMock).toHaveBeenCalledWith("vector_run_startup_reconcile", { projectPath: "/p/book", expected: [] })
  })

  it("压缩抛错：把错误信息展示到状态行，并复位按钮可用态", async () => {
    compactMock.mockRejectedValue(new Error("qdrant down"))
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 11/)
    fireEvent.click(screen.getByRole("button", { name: /立即压缩/ }))

    expect(await screen.findByText("qdrant down")).toBeTruthy()
    await waitFor(() => expect((screen.getByRole("button", { name: /立即压缩/ }) as HTMLButtonElement).disabled).toBe(false))
  })

  it("刷新按钮重新统计，摘要跟随新数值", async () => {
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 11/)
    countMock.mockResolvedValue(42)
    fireEvent.click(screen.getByRole("button", { name: /刷新/ }))
    expect(await screen.findByText("Chunk总数 42 · 旧表残留 3")).toBeTruthy()
    expect(countMock).toHaveBeenCalledTimes(2)
  })
})

