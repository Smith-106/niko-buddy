/** C4 冒烟覆盖：src/lib/novel/data-domain-registry.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DATA_DOMAINS, TRASH_BIN_DIR, trashBinPath, domainRequiresTypedConfirm } from "./data-domain-registry"
describe("data-domain-registry.ts smoke", () => {
  it("exports DATA_DOMAINS", () => {
    expect(DATA_DOMAINS).toBeDefined()
  })
  it("exports TRASH_BIN_DIR", () => {
    expect(TRASH_BIN_DIR).toBeDefined()
  })
  it("exports trashBinPath", () => {
    expect(trashBinPath).toBeDefined()
  })
  it("exports domainRequiresTypedConfirm", () => {
    expect(domainRequiresTypedConfirm).toBeDefined()
  })
})
