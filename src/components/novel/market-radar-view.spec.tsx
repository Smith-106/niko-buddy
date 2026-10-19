// @vitest-environment jsdom
/**
 * market-radar-view.spec.tsx — 市场雷达视图（诚实空态）契约。
 *
 * 覆盖：
 *   1. 空 projectPath → 空态；
 *   2. 指定项目 → 诚实「数据未接入」文案，不伪造榜单；
 *   3. 预留装载函数单测 → 恒返回空结构（connected:false，signals:[]）。
 *
 * 本视图无真数据源，不读磁盘；`@/commands/fs` mock 按统一要求保留。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), listDirectory: vi.fn() }
})

import { readFile } from "@/commands/fs"
import { MarketRadarView, loadMarketRadarSnapshot } from "./market-radar-view"

const readFileMock = vi.mocked(readFile)

afterEach(cleanup)

beforeEach(() => {
  readFileMock.mockReset()
})

describe("MarketRadarView", () => {
  it("空 projectPath → 空态", () => {
    render(<MarketRadarView projectPath="" />)
    expect(screen.getByTestId("market-radar-view")).toBeTruthy()
    expect(screen.getByTestId("market-radar-empty").textContent).toContain("未指定项目路径")
  })

  it("指定项目 → 诚实「数据未接入」，不伪造榜单", async () => {
    render(<MarketRadarView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("market-radar-empty")).toBeTruthy())
    expect(screen.getByTestId("market-radar-empty").textContent).toContain("数据未接入")
    expect(screen.queryByTestId("market-radar-list")).toBeNull()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("loadMarketRadarSnapshot → 恒返回空结构", async () => {
    await expect(loadMarketRadarSnapshot("C:/proj")).resolves.toEqual({
      projectPath: "C:/proj",
      connected: false,
      signals: [],
      reason: expect.stringContaining("未接入"),
    })
  })
})
