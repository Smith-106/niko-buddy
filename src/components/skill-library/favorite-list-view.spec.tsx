// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/skill-library/favorite-list-view.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { FavoriteListView } from "./favorite-list-view"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("favorite-list-view.tsx smoke", () => {
  it("renders FavoriteListView without crashing", () => {
    const C = FavoriteListView as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
