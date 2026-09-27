// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/book-analysis-version-history.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BookAnalysisVersionHistory } from "./book-analysis-version-history"
import { render } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("book-analysis-version-history.tsx smoke", () => {
  it("renders BookAnalysisVersionHistory without crashing", () => {
    const C = BookAnalysisVersionHistory as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })
})
