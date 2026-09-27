// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/timemachine/SnapshotTimeline.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { SnapshotTimeline } from "./SnapshotTimeline"
import DefaultExport from "./SnapshotTimeline"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("SnapshotTimeline.tsx smoke", () => {
  it("renders SnapshotTimeline without crashing", () => {
    const C = SnapshotTimeline as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
