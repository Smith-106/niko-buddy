// @vitest-environment jsdom
/**
 * report-page.spec.tsx — 报告页骨架只提供阅读层次，不改写传入的文案。
 *
 * @license MIT © Niko Buddy
 */

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ReportCallout, ReportPage, ReportSection } from "./report-page"

afterEach(() => {
  cleanup()
})

describe("ReportPage", () => {
  it("页题、说明和分区文案原样保留", () => {
    render(
      <ReportPage testId="report-root" title="创作中枢" description="只读，不写盘">
        <ReportSection testId="report-section" title="诊断结论">
          <ReportCallout testId="report-callout" tone="warn">
            项目尚未初始化：未找到 project-meta
          </ReportCallout>
        </ReportSection>
      </ReportPage>,
    )
    expect(screen.getByTestId("report-root").textContent).toContain("创作中枢")
    expect(screen.getByTestId("report-root").textContent).toContain("只读，不写盘")
    expect(screen.getByTestId("report-section").textContent).toContain("诊断结论")
    expect(screen.getByTestId("report-callout").textContent).toContain("项目尚未初始化：未找到 project-meta")
    const root = screen.getByTestId("report-root")
    const column = root.firstElementChild as HTMLElement
    expect(root.className).toContain("w-full")
    expect(column.className).toContain("w-full")
    expect(root.className).not.toContain("max-w-")
    expect(column.className).not.toContain("max-w-")
  })
})
