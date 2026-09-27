// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/gate/ConfirmGateDialog.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ConfirmGateDialog, GateHaltBanner } from "./ConfirmGateDialog"
import DefaultExport from "./ConfirmGateDialog"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("ConfirmGateDialog.tsx smoke", () => {
  it("renders ConfirmGateDialog without crashing", () => {
    const C = ConfirmGateDialog as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("renders GateHaltBanner without crashing", () => {
    const C = GateHaltBanner as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
