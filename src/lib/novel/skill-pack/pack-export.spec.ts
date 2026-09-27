/** C4 冒烟覆盖：src/lib/novel/skill-pack/pack-export.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { CREDENTIAL_KEY_PARTS, isCredentialLikeKey, stripCredentialKeys, stripCredentialLines, buildPack, serializePack } from "./pack-export"
describe("pack-export.ts smoke", () => {
  it("exports CREDENTIAL_KEY_PARTS", () => {
    expect(CREDENTIAL_KEY_PARTS).toBeDefined()
  })
  it("exports isCredentialLikeKey", () => {
    expect(isCredentialLikeKey).toBeDefined()
  })
  it("exports stripCredentialKeys", () => {
    expect(stripCredentialKeys).toBeDefined()
  })
  it("exports stripCredentialLines", () => {
    expect(stripCredentialLines).toBeDefined()
  })
  it("exports buildPack", () => {
    expect(buildPack).toBeDefined()
  })
  it("exports serializePack", () => {
    expect(serializePack).toBeDefined()
  })
})
