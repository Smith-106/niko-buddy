// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/settings/McpTransportSettings.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { McpTransportSettings } from "./McpTransportSettings"
import DefaultExport from "./McpTransportSettings"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("McpTransportSettings.tsx smoke", () => {
  it("renders McpTransportSettings without crashing", () => {
    const C = McpTransportSettings as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
  it("has default export", () => {
    expect(DefaultExport).toBeDefined()
  })
})
