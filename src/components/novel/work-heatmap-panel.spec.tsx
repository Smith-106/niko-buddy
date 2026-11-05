// @vitest-environment jsdom
/** 动态工作热力图面板：只读渲染 + 进度指针 + 空态/错误态 + 暂无声明三条。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { WorkHeatmapPanel } from "./work-heatmap-panel"
import { projectWorkHeatmap } from "@/lib/novel"

/** 项目路径可变（默认与原用例一致）；`null` = 未选项目。 */
const storeState = vi.hoisted(() => ({ projectPath: "C:/proj" as string | null }))
/** 缺省装载器（`loadNovelSessionStatus`）的注入点；无实现时委托真实现。 */
const barrelMock = vi.hoisted(() => ({ loadStatus: vi.fn() }))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
      selector({ project: storeState.projectPath === null ? null : { path: storeState.projectPath } }),
  }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    // 默认委托真实现（既有用例语义零变化）；新用例才注入实现。
    loadNovelSessionStatus: ((...args: Parameters<typeof actual.loadNovelSessionStatus>) =>
      barrelMock.loadStatus.getMockImplementation()
        ? barrelMock.loadStatus(...args)
        : actual.loadNovelSessionStatus(...args)) as typeof actual.loadNovelSessionStatus,
  }
})

const T0 = Date.parse("2026-10-18T00:00:00.000Z")

function projection() {
  return projectWorkHeatmap(
    {
      status: "running",
      activeStepIndex: 2,
      updatedAt: "2026-10-18T00:30:00.000Z",
      currentChapterNumber: 7,
      stageMetrics: [
        { stage: "write_llm", tokenCost: 900, latencyMs: 5000, timestamp: new Date(T0 + 10 * 60 * 1000).toISOString() },
        { stage: "write_llm", tokenCost: 100, latencyMs: 1000, timestamp: new Date(T0 + 20 * 60 * 1000).toISOString() },
        { stage: "six_dim", tokenCost: 50, latencyMs: 200, partial: true, timestamp: new Date(T0 + 20 * 60 * 1000).toISOString() },
      ],
    },
    { now: T0 + 30 * 60 * 1000, maxBuckets: 2 },
  )
}

afterEach(() => {
  cleanup()
  barrelMock.loadStatus.mockReset()
  storeState.projectPath = "C:/proj"
})

describe("有数据：渲染阶段行与时间桶", () => {
  it("两个 stage 行都在，格子带 data-count，合计正确", () => {
    render(<WorkHeatmapPanel projection={projection()} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-panel")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-row-write_llm")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-row-six_dim")).toBeTruthy()
    const filled = screen
      .getAllByTestId(/^work-heatmap-cell-/)
      .filter((el) => Number(el.getAttribute("data-count")) > 0)
    expect(filled.length).toBeGreaterThan(0)
    expect(filled.reduce((sum, el) => sum + Number(el.getAttribute("data-count")), 0)).toBe(3)
  })

  it("进度指针渲染真实值（步骤=2、章=7 精确匹配，不靠碰巧出现的数字）", () => {
    render(<WorkHeatmapPanel projection={projection()} refreshMs={0} />)
    const progress = screen.getByTestId("work-heatmap-progress").textContent ?? ""
    expect(progress).toContain("running")
    // 精确口径：步骤 2、当前章 7（用「步骤 2」「第 7」形式断言，避免从别的数字里蒙中）
    expect(progress).toMatch(/步骤\s*2(?![0-9])/)
    expect(progress).toMatch(/(?:第\s*7\s*章|章\s*7(?![0-9]))/)
  })

  it("partial 计数出现在行合计里", () => {
    render(<WorkHeatmapPanel projection={projection()} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-row-six_dim").textContent).toContain("partial 1")
  })
})

describe("空态与暂无声明：不画空网格", () => {
  it("投影为空 → 空态文案出现，且没有网格", () => {
    render(<WorkHeatmapPanel projection={projectWorkHeatmap({})} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-empty")).toBeTruthy()
    expect(screen.queryByTestId("work-heatmap-grid")).toBeNull()
  })

  it("三条不适用声明都渲染（章节轴/实时流/质量分）", () => {
    render(<WorkHeatmapPanel projection={projectWorkHeatmap({})} refreshMs={0} />)
    expect(screen.getByTestId("work-heatmap-na-chapter-axis")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-na-live-stream")).toBeTruthy()
    expect(screen.getByTestId("work-heatmap-na-quality-score")).toBeTruthy()
    // 「不是事件流」必须写明，不能假装流式
    expect(screen.getByTestId("work-heatmap-scope").textContent).toContain("不是事件流")
  })
})

/** 手动控制的 promise（测竞态：谁先 resolve 不等于谁先发起）。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("装载器：错误态不覆盖数据、null 给显式空态文案", () => {
  it("loader 抛错 → work-heatmap-error 出现", async () => {
    const loader = vi.fn(async () => {
      throw new Error("boom")
    })
    render(<WorkHeatmapPanel loader={loader} refreshMs={0} />)
    await waitFor(() => {
      expect(screen.getByTestId("work-heatmap-error").textContent).toContain("boom")
    })
  })

  it("loader 返回 null → 明确说读不到 status.json（不是静默空图）", async () => {
    const loader = vi.fn(async () => null)
    render(<WorkHeatmapPanel loader={loader} refreshMs={0} />)
    await waitFor(() => {
      expect(screen.getByTestId("work-heatmap-error").textContent).toContain("读不到")
    })
  })
})

describe("覆盖补齐：状态文案/兜底文案/色阶/装载路径", () => {
  it("statusPlain 全映射：paused/failed/error/done/completed/未知", () => {
    const cases: Array<[string | null, string]> = [
      ["paused", "已暂停"],
      ["failed", "失败"],
      ["error", "失败"],
      ["done", "完成"],
      ["completed", "完成"],
      ["weird-state", "已记录"],
    ]
    for (const [status, plain] of cases) {
      const { unmount } = render(
        <WorkHeatmapPanel
          input={{ status, activeStepIndex: null, currentChapterNumber: null, updatedAt: null }}
          refreshMs={0}
        />,
      )
      expect(screen.getByTestId("work-heatmap-progress").textContent).toContain(plain)
      unmount()
      cleanup()
    }
  })

  it("naPlain/missingPlain 兜底：未知 id → 不适用/缺资料", () => {
    const base = projection()
    render(
      <WorkHeatmapPanel
        projection={{
          ...base,
          notApplicable: [{ id: "mystery-dim", label: "神秘维度", reason: "r" }],
          missingSources: ["some-other-source"],
        }}
        refreshMs={0}
      />,
    )
    expect(screen.getByTestId("work-heatmap-na-mystery-dim").textContent).toContain("不适用")
    expect(screen.getByTestId("work-heatmap-missing").textContent).toContain("缺资料")
  })

  it("色阶：0.25–0.5 → /45，<0.25 → /30", () => {
    const base = projection()
    const cell = (bucketIndex: number, count: number) => ({
      stage: "write_llm",
      bucketIndex,
      count,
      tokenCost: null as number | null,
      latencyMs: null as number | null,
      partialCount: 0,
    })
    render(
      <WorkHeatmapPanel
        projection={{
          ...base,
          maxCount: 100,
          rows: [
            {
              stage: "write_llm",
              cells: [cell(0, 30), cell(1, 10)],
              count: 40,
              tokenCost: null,
              latencyMs: null,
              partialCount: 0,
            },
          ],
        }}
        refreshMs={0}
      />,
    )
    expect(screen.getByTestId("work-heatmap-cell-write_llm-0").className).toContain("bg-success/45")
    expect(screen.getByTestId("work-heatmap-cell-write_llm-1").className).toContain("bg-success/30")
  })

  it("无时间戳条目 → undated 单列（不进时间轴）", () => {
    const base = projection()
    render(
      <WorkHeatmapPanel projection={{ ...base, undated: [{ stage: "write_llm", count: 2 }] }} refreshMs={0} />,
    )
    expect(screen.getByTestId("work-heatmap-undated").textContent).toContain("2 条")
  })

  it("缺省装载器：经 projectPath 读 status（失败 → 显式读不到文案）", async () => {
    // 不传 projection/input/loader：走 wiki-store project + 真实 loadNovelSessionStatus
    render(<WorkHeatmapPanel refreshMs={0} />)
    await waitFor(() => {
      expect(screen.getByTestId("work-heatmap-error").textContent).toContain("读不到写作状态")
    })
  })

  it("立即刷新按钮：点击触发重读", async () => {
    const loader = vi.fn(async () => ({ status: "running" as const }))
    render(<WorkHeatmapPanel loader={loader} refreshMs={0} />)
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId("work-heatmap-refresh"))
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
  })

  it("轮询：refreshMs>0 按周期重读，可见性变化即时刷新，卸载清定时器", async () => {
    vi.useFakeTimers()
    try {
      const loader = vi.fn(async () => ({ status: "running" as const }))
      const { unmount } = render(<WorkHeatmapPanel loader={loader} refreshMs={50} />)
      expect(loader).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(120)
      expect(loader.mock.calls.length).toBeGreaterThanOrEqual(3)
      // 页面重新可见 → 立即刷新一次（onVisible 分支）
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(0)
      const afterVisible = loader.mock.calls.length
      expect(afterVisible).toBeGreaterThanOrEqual(4)
      // 页面隐藏 → 周期 tick 跳过（hidden 早退分支）
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
      await vi.advanceTimersByTimeAsync(120)
      expect(loader.mock.calls.length).toBe(afterVisible)
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
      const calls = loader.mock.calls.length
      unmount()
      await vi.advanceTimersByTimeAsync(200)
      expect(loader.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
    cleanup()
  })
})

describe("覆盖补齐（语句收口）：idle 文案 / 缺省装载成功 / 无项目 / 竞态守卫 / 色阶兜底", () => {
  it("status=idle → 状态文案「空闲」", () => {
    render(
      <WorkHeatmapPanel
        input={{ status: "idle", activeStepIndex: null, currentChapterNumber: null, updatedAt: null }}
        refreshMs={0}
      />,
    )
    expect(screen.getByTestId("work-heatmap-progress").textContent).toContain("空闲")
  })

  it("缺省装载器成功：status.json 形状经 toWorkHeatmapInput 转成网格（步骤/章/阶段行）", async () => {
    barrelMock.loadStatus.mockResolvedValue({
      status: "running",
      active_step_index: 1,
      updated_at: "2026-10-18T00:05:00.000Z",
      current_task: { chapter_number: 4 },
      stage_metrics: [
        { stage: "write_llm", tokenCost: 10, latencyMs: 5, timestamp: new Date(T0 + 5 * 60 * 1000).toISOString() },
      ],
    })
    render(<WorkHeatmapPanel refreshMs={0} />)

    await waitFor(() => expect(screen.getByTestId("work-heatmap-grid")).toBeTruthy())
    expect(barrelMock.loadStatus).toHaveBeenCalledWith("C:/proj")
    const progress = screen.getByTestId("work-heatmap-progress").textContent ?? ""
    expect(progress).toMatch(/步骤\s*1(?![0-9])/)
    expect(progress).toMatch(/章\s*4(?![0-9])/)
    expect(progress).toContain("2026-10-18T00:05:00.000Z")
    const row = screen.getByTestId("work-heatmap-row-write_llm")
    expect(row.textContent).toContain("模型写作")
    // 装载成功即无错误态
    expect(screen.queryByTestId("work-heatmap-error")).toBeNull()
    // 上次刷新时间戳落了（说明本轮读盘真的走完）
    expect(screen.getByTestId("work-heatmap-progress").textContent).toContain("上次刷新")
  })

  it("未选项目且无装载器：不读盘、不报错、刷新按钮不卡「刷新中」", async () => {
    storeState.projectPath = null
    render(<WorkHeatmapPanel refreshMs={0} />)

    fireEvent.click(screen.getByTestId("work-heatmap-refresh"))
    await waitFor(() => expect(screen.getByTestId("work-heatmap-empty")).toBeTruthy())
    expect(screen.queryByTestId("work-heatmap-error")).toBeNull()
    // 没有任何装载器可跑 → refreshing 保持 false（按钮文案不卡在刷新中）
    expect(screen.getByTestId("work-heatmap-refresh").textContent).toContain("立即刷新")
    expect(screen.getByTestId("work-heatmap-progress").textContent).not.toContain("上次刷新")
  })

  it("竞态：旧响应的成功晚到不覆盖新响应（序号守卫）", async () => {
    const slow = deferred<{ status: string } | null>()
    const fast = deferred<{ status: string } | null>()
    const loaderA = vi.fn<() => Promise<{ status: string } | null>>(() => slow.promise)
    const loaderB = vi.fn<() => Promise<{ status: string } | null>>(() => fast.promise)
    // 首读挂起（按钮此时被 refreshing 禁用，故用 loader 身份变化触发第二轮）
    const { rerender } = render(<WorkHeatmapPanel loader={loaderA} refreshMs={0} />)

    await waitFor(() => expect(loaderA).toHaveBeenCalledTimes(1))
    rerender(<WorkHeatmapPanel loader={loaderB} refreshMs={0} />)
    await waitFor(() => expect(loaderB).toHaveBeenCalledTimes(1))

    // 后发先至：新响应先落地
    await act(async () => {
      fast.resolve({ status: "idle" })
    })
    await waitFor(() =>
      expect(screen.getByTestId("work-heatmap-progress").textContent).toContain("空闲"),
    )

    // 旧响应晚到 → 必须被丢弃（不能把「进行中」盖回来）
    await act(async () => {
      slow.resolve({ status: "running" })
    })
    const progress = screen.getByTestId("work-heatmap-progress").textContent ?? ""
    expect(progress).toContain("空闲")
    expect(progress).not.toContain("进行中")
  })

  it("竞态：旧响应的失败晚到不覆盖新数据（错误态不闪现）", async () => {
    const slow = deferred<{ status: string } | null>()
    const fast = deferred<{ status: string } | null>()
    const loaderA = vi.fn<() => Promise<{ status: string } | null>>(() => slow.promise)
    const loaderB = vi.fn<() => Promise<{ status: string } | null>>(() => fast.promise)
    const { rerender } = render(<WorkHeatmapPanel loader={loaderA} refreshMs={0} />)

    await waitFor(() => expect(loaderA).toHaveBeenCalledTimes(1))
    rerender(<WorkHeatmapPanel loader={loaderB} refreshMs={0} />)
    await waitFor(() => expect(loaderB).toHaveBeenCalledTimes(1))

    await act(async () => {
      fast.resolve({ status: "idle" })
    })
    await waitFor(() =>
      expect(screen.getByTestId("work-heatmap-progress").textContent).toContain("空闲"),
    )

    await act(async () => {
      slow.reject(new Error("stale boom"))
    })
    // 旧请求的错误不许落到错误态上（新数据已成立）
    expect(screen.queryByTestId("work-heatmap-error")).toBeNull()
    expect(screen.getByTestId("work-heatmap-progress").textContent).toContain("空闲")
  })

  it("未知 stage 回退「阶段」+ maxCount≤0 时色阶落最浅档", () => {
    const base = projection()
    render(
      <WorkHeatmapPanel
        projection={{
          ...base,
          maxCount: 0,
          rows: [
            {
              stage: "mystery_stage",
              cells: [
                { stage: "mystery_stage", bucketIndex: 0, count: 3, tokenCost: null, latencyMs: null, partialCount: 0 },
              ],
              count: 3,
              tokenCost: null,
              latencyMs: null,
              partialCount: 0,
            },
          ],
        }}
        refreshMs={0}
      />,
    )
    const row = screen.getByTestId("work-heatmap-row-mystery_stage")
    const header = row.querySelector("th")
    // 可见标签回退到「阶段」；原始 stage 码点只留在读屏 sr-only 里
    expect(header?.textContent).toContain("阶段")
    expect(header?.querySelector(".sr-only")?.textContent).toBe("mystery_stage")
    expect(screen.getByTestId("work-heatmap-cell-mystery_stage-0").className).toContain("bg-success/30")
  })

  it("缺时间戳真源 → 缺源清单说明「画不出时间轴」", () => {
    const base = projection()
    render(
      <WorkHeatmapPanel
        projection={{ ...base, missingSources: ["`stage_metrics[].timestamp`（无可解析时间戳）"] }}
        refreshMs={0}
      />,
    )
    expect(screen.getByTestId("work-heatmap-missing").textContent).toContain("画不出时间轴")
  })

  it("条目全在窗口外 → 空态说明「早于窗口」，不是「缺时间戳」", () => {
    const folded = projectWorkHeatmap(
      { stageMetrics: [{ stage: "write_llm", tokenCost: 1, latencyMs: 1, timestamp: new Date(T0).toISOString() }] },
      { now: T0 + 30 * 24 * 60 * 60 * 1000, maxBuckets: 2 },
    )
    expect(folded.foldedCount).toBe(1)
    render(<WorkHeatmapPanel projection={folded} refreshMs={0} />)
    const empty = screen.getByTestId("work-heatmap-empty").textContent ?? ""
    expect(empty).toContain("早于窗口")
    expect(empty).toContain("这不是「缺时间戳」")
    expect(screen.queryByTestId("work-heatmap-grid")).toBeNull()
  })
})

describe("覆盖补齐（语句收口 · 续）：真装载器 reject / 卸载竞态 / 隐藏时可见性事件", () => {
  it("真装载器 reject → catch 兜底成 null，落「读不到写作状态」错误态（不崩）", async () => {
    barrelMock.loadStatus.mockRejectedValue(new Error("status.json boom"))
    render(<WorkHeatmapPanel refreshMs={0} />)

    const error = await screen.findByTestId("work-heatmap-error")
    expect(error.textContent).toContain("读不到写作状态")
    // 真被调到的仍是项目路径（不是别的项目）
    expect(barrelMock.loadStatus).toHaveBeenCalledWith("C:/proj")
  })

  it("读盘未完成就卸载：晚到的响应不再 setState / setRefreshing（不崩）", async () => {
    const pending = deferred<{ status: string } | null>()
    const loader = vi.fn<() => Promise<{ status: string } | null>>(() => pending.promise)
    const { unmount } = render(<WorkHeatmapPanel loader={loader} refreshMs={0} />)
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1))

    unmount()
    await act(async () => {
      pending.resolve({ status: "running" })
    })
    expect(screen.queryByTestId("work-heatmap-panel")).toBeNull()
  })

  it("页面隐藏时收到 visibilitychange → 不触发重读；可见时才重读", async () => {
    const loader = vi.fn(async () => ({ status: "running" as const }))
    render(<WorkHeatmapPanel loader={loader} refreshMs={100000} />)
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1))

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    try {
      document.dispatchEvent(new Event("visibilitychange"))
      await act(async () => {
        await Promise.resolve()
      })
      expect(loader).toHaveBeenCalledTimes(1)

      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
      document.dispatchEvent(new Event("visibilitychange"))
      await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    }
  })
})
