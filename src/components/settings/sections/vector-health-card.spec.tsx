/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { VectorHealthCard } from "./vector-health-card"

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

describe("VectorHealthCard", () => {
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
})
