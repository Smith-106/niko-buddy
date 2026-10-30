/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { dropLegacyVectorTable } from "@/lib/embedding"
import { VectorHealthCard } from "./vector-health-card"

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
  useWikiStore: (sel: (s: { project: { path: string } | null }) => unknown) =>
    sel({ project: { path: "/p/book" } }),
}))
vi.mock("@/lib/embedding", () => ({
  countVectorChunks: vi.fn(async () => 7),
  legacyVectorRowCount: vi.fn(async () => 0),
  triggerIdleCompaction: vi.fn(async () => ({ chunks_compacted: 1, old_fragments_cleared: 0 })),
  dropLegacyVectorTable: vi.fn(async () => {}),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ skipped: true })) }))

function stubConfirm() {
  const fn = vi.fn<(message?: string) => boolean>()
  window.confirm = fn
  return fn
}

describe("VectorHealthCard", () => {
  beforeEach(() => {
    vi.mocked(dropLegacyVectorTable).mockClear()
  })
  const realConfirm = window.confirm
  afterEach(() => {
    cleanup()
    window.confirm = realConfirm
  })

  it("渲染健康数与三个运维按钮", async () => {
    render(<VectorHealthCard />)
    expect(await screen.findByTestId("vector-health-card")).toBeTruthy()
    expect(await screen.findByText(/Chunk总数 7/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /立即压缩/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /对账校验/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /清理旧版残留/ })).toBeTruthy()
  })

  it("空清单对账诚实展示已跳过，不假报 reconcile ok", async () => {
    render(<VectorHealthCard />)
    fireEvent.click(screen.getAllByRole("button", { name: /对账校验/ })[0])
    expect(await screen.findByText(/已跳过/)).toBeTruthy()
  })

  it("清理旧版残留：第一次确认取消 → 不删除", async () => {
    const confirmSpy = stubConfirm().mockReturnValueOnce(false)
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 7/)
    fireEvent.click(screen.getByTestId("vector-health-drop-legacy"))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0][0]).toMatch(/不可恢复/)
    expect(dropLegacyVectorTable).not.toHaveBeenCalled()
  })

  it("清理旧版残留：第二次确认取消 → 不删除", async () => {
    const confirmSpy = stubConfirm().mockReturnValueOnce(true).mockReturnValueOnce(false)
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 7/)
    fireEvent.click(screen.getByTestId("vector-health-drop-legacy"))
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(dropLegacyVectorTable).not.toHaveBeenCalled()
  })

  it("清理旧版残留：两次确认通过 → 删除并提示完成；按钮为危险样式", async () => {
    stubConfirm().mockReturnValue(true)
    render(<VectorHealthCard />)
    await screen.findByText(/Chunk总数 7/)
    const btn = screen.getByTestId("vector-health-drop-legacy")
    expect(btn.className).toContain("bg-destructive")
    fireEvent.click(btn)
    await waitFor(() => expect(dropLegacyVectorTable).toHaveBeenCalledWith("/p/book"))
    expect(await screen.findByText("旧版残留已清理")).toBeTruthy()
  })
})
