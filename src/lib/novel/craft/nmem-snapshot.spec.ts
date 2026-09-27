/** C4 冒烟覆盖：src/lib/novel/craft/nmem-snapshot.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { NMEM_SNAPSHOT_VERSION, NMEM_SNAPSHOT_CAPTURED_AT, NMEM_SERVER_VERSION, NMEM_SPACE_ID, NMEM_SNAPSHOT, validateNmemSnapshot } from "./nmem-snapshot"
describe("nmem-snapshot.ts smoke", () => {
  it("exports NMEM_SNAPSHOT_VERSION", () => {
    expect(NMEM_SNAPSHOT_VERSION).toBeDefined()
  })
  it("exports NMEM_SNAPSHOT_CAPTURED_AT", () => {
    expect(NMEM_SNAPSHOT_CAPTURED_AT).toBeDefined()
  })
  it("exports NMEM_SERVER_VERSION", () => {
    expect(NMEM_SERVER_VERSION).toBeDefined()
  })
  it("exports NMEM_SPACE_ID", () => {
    expect(NMEM_SPACE_ID).toBeDefined()
  })
  it("exports NMEM_SNAPSHOT", () => {
    expect(NMEM_SNAPSHOT).toBeDefined()
  })
  it("exports validateNmemSnapshot", () => {
    expect(validateNmemSnapshot).toBeDefined()
  })
})
