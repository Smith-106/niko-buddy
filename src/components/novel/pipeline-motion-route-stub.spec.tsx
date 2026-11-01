// @vitest-environment jsdom
/**
 * pipeline-motion-route-stub.spec — P1 面板分支桩 + 形态分支 + 选择器（TASK-003/004）。
 *
 * 覆盖：
 * - V6：路线 fieldset+legend + A/B/C/D 四原生 button（默认 A 选中 aria-pressed）；
 *   切 B 显示分支桩回落 hint + 显式 ID 说明（D1），无 div onClick；
 * - V8：形态 fieldset + 四形态 button（章回正文/卷纲合集/设定集/出版导出包）+ 能力池注脚；
 * - SVG 桩：motion-route-stub-b/c/d 与 motion-branch-morph-* 在有事件图上渲染；
 * - 回归：零事件空态保留（motion-empty 在，不渲染 diagram）；
 * - TRUNK 主干 11 边不动（motion-edge-0..10 全渲染）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { appendRunEvents, createRunEventLedger, type RunEventInput } from "@/lib/novel"

import { PipelineMotionPanel } from "./pipeline-motion-panel"

afterEach(cleanup)

const TS = "2026-10-19T00:00:00.000Z"

function input(seq: number, kind: RunEventInput["kind"], extra?: Partial<RunEventInput>): RunEventInput {
  return { seq, eventId: `e:${seq}`, ts: TS, kind, actor: "system", ...extra }
}

function panelProps(inputs: RunEventInput[]) {
  const ledger = appendRunEvents(createRunEventLedger(), inputs)
  return { input: { events: ledger.events } }
}

describe("PipelineMotionPanel 路线/形态选择器", () => {
  it("空态下选择器仍可用：两 fieldset + legend + 8 个原生 button", () => {
    render(<PipelineMotionPanel />)
    expect(screen.getByTestId("motion-empty")).toBeTruthy()
    expect(screen.getByTestId("motion-route-fieldset")).toBeTruthy()
    expect(screen.getByTestId("motion-morph-fieldset")).toBeTruthy()
    for (const id of ["motion-route-a", "motion-route-b", "motion-route-c", "motion-route-d"]) {
      const button = screen.getByTestId(id)
      expect(button.tagName).toBe("BUTTON")
    }
    for (const id of ["motion-morph-chapter", "motion-morph-volume", "motion-morph-setting", "motion-morph-export"]) {
      const button = screen.getByTestId(id)
      expect(button.tagName).toBe("BUTTON")
    }
  })

  it("默认 A：routeADefault hint 可见；切 B 显示分支桩 hint + 显式 ID 说明", () => {
    render(<PipelineMotionPanel />)
    expect(screen.getByTestId("motion-route-a").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("motion-route-hint").textContent).toContain("默认走 A 路")
    fireEvent.click(screen.getByTestId("motion-route-b"))
    expect(screen.getByTestId("motion-route-b").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("motion-route-a").getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByTestId("motion-route-hint").textContent).toContain("P1 仅分支桩")
    expect(screen.getByTestId("motion-route-b-note").textContent).toContain("范文ID")
  })

  it("形态四分支文案：章回正文/卷纲合集/设定集/出版导出包 + 能力池注脚", () => {
    render(<PipelineMotionPanel />)
    expect(screen.getByTestId("motion-morph-chapter").textContent).toContain("章回正文")
    expect(screen.getByTestId("motion-morph-volume").textContent).toContain("卷纲合集")
    expect(screen.getByTestId("motion-morph-setting").textContent).toContain("设定集")
    expect(screen.getByTestId("motion-morph-export").textContent).toContain("出版导出包")
    expect(screen.getByTestId("motion-capability-note").textContent).toContain("12 主泳道")
    fireEvent.click(screen.getByTestId("motion-morph-export"))
    expect(screen.getByTestId("motion-morph-export").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("motion-morph-chapter").getAttribute("aria-pressed")).toBe("false")
  })

  it("选择器内无 div onClick（键盘可达：原生 button）", () => {
    const { container } = render(<PipelineMotionPanel />)
    for (const testId of ["motion-route-fieldset", "motion-morph-fieldset"]) {
      const root = screen.getByTestId(testId)
      expect(root.tagName).toBe("FIELDSET")
      expect(root.querySelector("legend")).not.toBeNull()
      expect(container.querySelector(`[data-testid=\"${testId}\"] div[onclick]`)).toBeNull()
    }
  })
})

describe("PipelineMotionPanel SVG 分支桩与形态徽", () => {
  it("有事件图上 B/C/D 桩 + 四形态徽 + TRUNK 11 边全渲染", () => {
    render(<PipelineMotionPanel {...panelProps([input(0, "retrieval"), input(1, "generate")])} />)
    expect(screen.getByTestId("motion-diagram")).toBeTruthy()
    expect(screen.getByTestId("motion-route-stub-b")).toBeTruthy()
    expect(screen.getByTestId("motion-route-stub-c")).toBeTruthy()
    expect(screen.getByTestId("motion-route-stub-d")).toBeTruthy()
    for (const id of ["morph-chapter", "morph-volume", "morph-setting", "morph-export"]) {
      expect(screen.getByTestId(`motion-branch-${id}`)).toBeTruthy()
    }
    for (let i = 0; i < 11; i += 1) {
      expect(screen.getByTestId(`motion-edge-${i}`)).toBeTruthy()
    }
  })
})
