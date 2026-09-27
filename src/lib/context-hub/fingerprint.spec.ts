/** C4 冒烟覆盖：src/lib/context-hub/fingerprint.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { sha256Text } from "./fingerprint"
describe("fingerprint.ts smoke", () => {
  it("exports sha256Text", () => {
    expect(sha256Text).toBeDefined()
  })
})
