// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/rumor-propagation-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { RumorPropagationPanel } from "./rumor-propagation-panel"
import { render } from "@/test-helpers/component-test-utils"
describe("rumor-propagation-panel.tsx smoke", () => {
  it("renders RumorPropagationPanel without crashing", () => {
    const { unmount } = render(<RumorPropagationPanel rumors={[]} agents={new Map()} events={[]} />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
