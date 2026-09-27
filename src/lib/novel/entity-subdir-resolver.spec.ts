/** C4 冒烟覆盖：src/lib/novel/entity-subdir-resolver.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ENTITY_SUBDIRS, entitySubdirOf, entitySubdirFromTags, resolveEntityPath, listEntityFiles } from "./entity-subdir-resolver"
describe("entity-subdir-resolver.ts smoke", () => {
  it("exports ENTITY_SUBDIRS", () => {
    expect(ENTITY_SUBDIRS).toBeDefined()
  })
  it("exports entitySubdirOf", () => {
    expect(entitySubdirOf).toBeDefined()
  })
  it("exports entitySubdirFromTags", () => {
    expect(entitySubdirFromTags).toBeDefined()
  })
  it("exports resolveEntityPath", () => {
    expect(resolveEntityPath).toBeDefined()
  })
  it("exports listEntityFiles", () => {
    expect(listEntityFiles).toBeDefined()
  })
})
