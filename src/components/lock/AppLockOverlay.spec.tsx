// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/lock/AppLockOverlay.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { AppLockOverlay } from "./AppLockOverlay"
import DefaultExport from "./AppLockOverlay"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("AppLockOverlay.tsx smoke", () => {
  it("renders AppLockOverlay without crashing", () => {
    const C = AppLockOverlay as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
