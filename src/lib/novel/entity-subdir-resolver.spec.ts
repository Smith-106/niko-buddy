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

describe("entity-subdir-resolver 行为补齐：tags 推导子目录", () => {
  it("无 tags / 空 tags → null（无分类信息回退扁平）", () => {
    expect(entitySubdirFromTags()).toBeNull()
    expect(entitySubdirFromTags([])).toBeNull()
  })

  it("tags 命中 → 对应子目录；优先级 character > organization > location > item", () => {
    expect(entitySubdirFromTags(["item"])).toBe("items")
    expect(entitySubdirFromTags(["location", "item"])).toBe("locations")
    expect(entitySubdirFromTags(["organization", "location"])).toBe("organizations")
    expect(entitySubdirFromTags(["character", "organization"])).toBe("characters")
  })

  it("tags 均非实体分类 → null（不误落 events）", () => {
    expect(entitySubdirFromTags(["event", "system"])).toBeNull()
    expect(entitySubdirFromTags(["foo", "bar"])).toBeNull()
  })
})
