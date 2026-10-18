// @vitest-environment jsdom
/** 风格/节奏雷达面板：SVG 多边形来自投影、无正文不画、目标风格与目标节奏分栏、N/A 三条。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import { StyleRadarPanel } from "./style-radar-panel"
import { projectStyleRadar } from "@/lib/novel"

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
      selector({ project: { path: "C:/proj" } }),
  }
})

const SAMPLE = [
  "“你到底来不来？”林昭把门推开一条缝，风灌进来。",
  "她没有回答。走廊尽头的灯闪了一下，又灭了。",
  "他说：“那就别怪我。”话音落地，窗外的雨声忽然大起来，像有人拿指节在敲玻璃。",
].join("\n\n")

afterEach(cleanup)

describe("有正文：画雷达", () => {
  it("svg 与 polygon 都在，且 polygon points 非空、不是全零（不画 0 分雷达）", () => {
    render(<StyleRadarPanel projection={projectStyleRadar({ text: SAMPLE })} />)
    expect(screen.getByTestId("style-radar-svg")).toBeTruthy()
    const points = screen.getByTestId("style-radar-polygon").getAttribute("points") ?? ""
    expect(points.length).toBeGreaterThan(0)
    expect(points).not.toBe("120.00,120.00 120.00,120.00 120.00,120.00 120.00,120.00 120.00,120.00 120.00,120.00")
  })

  it("六轴数值逐项等于投影值，均分也对上；并写清是机械代理指标", () => {
    const projection = projectStyleRadar({ text: SAMPLE })
    render(<StyleRadarPanel projection={projection} />)
    for (const axis of projection.axes) {
      const text = screen.getByTestId(`style-radar-axis-${axis.key}`).textContent ?? ""
      expect(text).toContain(axis.value === null ? "N/A" : axis.value.toFixed(1))
    }
    expect(screen.getByTestId("style-radar-axes").textContent).toContain(
      projection.overall!.toFixed(1),
    )
    expect(screen.getByTestId("style-radar-scope").textContent).toContain("机械代理指标")
  })
})

describe("无正文：不画", () => {
  it("空态出现、没有 svg、轴值显示 N/A 而不是 0", () => {
    render(<StyleRadarPanel projection={projectStyleRadar({})} />)
    expect(screen.getByTestId("style-radar-empty")).toBeTruthy()
    expect(screen.queryByTestId("style-radar-svg")).toBeNull()
    // 空态下不渲染数值列表，也不出现 "0.0"
    expect(screen.queryByTestId("style-radar-axes")).toBeNull()
    expect(screen.getByTestId("style-radar-panel").textContent).not.toMatch(/：0\.0/)
  })
})

describe("量纲隔离与文本维度", () => {
  it("目标节奏分栏显示压力级/情绪；目标风格文本不进雷达数值列表", () => {
    render(
      <StyleRadarPanel
        projection={projectStyleRadar({
          text: SAMPLE,
          target: { chapterLabel: "第 7 章", pressureLevel: 4, emotionIntensity: 8 },
          targetStyle: { narrativeVoice: "第三人称限知", sentenceStyle: "短句为主" },
        })}
      />,
    )
    const target = screen.getByTestId("style-radar-target").textContent ?? ""
    expect(target).toMatch(/章节：第 7 章/)
    expect(target).toMatch(/压力级：4(?!\d)/)
    expect(target).toMatch(/情绪强度：8(?!\d)/)
    expect(target).toContain("不同量纲")

    const styleBox = screen.getByTestId("style-radar-target-style").textContent ?? ""
    expect(styleBox).toContain("第三人称限知")
    expect(styleBox).toContain("短句为主")
    // 文本维度不得出现在雷达轴数值列表里
    expect(screen.getByTestId("style-radar-axes").textContent).not.toContain("第三人称限知")
  })

  it("未选风格画像 → 显式 N/A 文案", () => {
    render(<StyleRadarPanel projection={projectStyleRadar({ text: SAMPLE })} />)
    expect(screen.getByTestId("style-radar-target-style").textContent).toContain("N/A")
  })
})

describe("不适用三条 + 装载器", () => {
  it("三条 N/A 都渲染（文风九维 / 文学分 / 叠量纲）", () => {
    render(<StyleRadarPanel projection={projectStyleRadar({ text: SAMPLE })} />)
    expect(screen.getByTestId("style-radar-na-text-style-axes")).toBeTruthy()
    expect(screen.getByTestId("style-radar-na-literary-score")).toBeTruthy()
    expect(screen.getByTestId("style-radar-na-cross-scale-overlay")).toBeTruthy()
  })

  it("loader 抛错 → 错误态可见", async () => {
    const loader = vi.fn(async () => {
      throw new Error("loader-boom")
    })
    render(<StyleRadarPanel loader={loader} />)
    await waitFor(() => {
      expect(screen.getByTestId("style-radar-error").textContent).toContain("loader-boom")
    })
  })
})
