// @vitest-environment jsdom
/** F4-7 冒烟覆盖：progress-panel.tsx（自 story-simulation-view 剥离的通用进度面板） */
import { describe, expect, it } from "vitest"
import { ProgressPanel } from "./progress-panel"
import { render } from "@/test-helpers/component-test-utils"
describe("progress-panel.tsx smoke", () => {
  it("渲染 label+百分比；取消按钮回调", () => {
    let cancelled = 0
    const { unmount } = render(
      <ProgressPanel progress={42} label="推演中UNIQUE-PROG-407" onCancel={() => { cancelled += 1 }} />,
    )
    expect(document.body.textContent ?? "").toContain("推演中UNIQUE-PROG-407")
    expect(document.body.textContent ?? "").toContain("42%")
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(cancelled).toBe(1)
    unmount()
  })
  it("progress 越界钳制 0-100", () => {
    const { unmount } = render(<ProgressPanel progress={150} label="x" />)
    expect(document.body.textContent ?? "").toContain("100%")
    unmount()
  })
})
