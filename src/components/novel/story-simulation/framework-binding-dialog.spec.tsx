// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/framework-binding-dialog.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { FrameworkBindingDialog } from "./framework-binding-dialog"
import { render } from "@/test-helpers/component-test-utils"
describe("framework-binding-dialog.tsx smoke", () => {
  it("renders FrameworkBindingDialog without crashing", () => {
    const framework = { id: "f1", title: "测试框架", premise: "前提", targetWords: 1000, simulationMode: "event-driven" as const, sourceChapters: 0, nodes: [], createdAt: "" }
    const { unmount } = render(<FrameworkBindingDialog open={false} onOpenChange={() => {}} framework={framework} onBound={() => {}} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
