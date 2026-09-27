/** C4 冒烟覆盖：src/lib/novel/classification/classification-loader.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { loadClassificationConfig, loadProjectClassification, readProjectClassificationRaw, mergeRoutes, initProjectClassification, writeProjectClassification, validateFeatureRoutes, getRouteRule, resolveRouteRule, checkClassificationVersion, upgradeClassificationConfig } from "./classification-loader"
describe("classification-loader.ts smoke", () => {
  it("exports loadClassificationConfig", () => {
    expect(loadClassificationConfig).toBeDefined()
  })
  it("exports loadProjectClassification", () => {
    expect(loadProjectClassification).toBeDefined()
  })
  it("exports readProjectClassificationRaw", () => {
    expect(readProjectClassificationRaw).toBeDefined()
  })
  it("exports mergeRoutes", () => {
    expect(mergeRoutes).toBeDefined()
  })
  it("exports initProjectClassification", () => {
    expect(initProjectClassification).toBeDefined()
  })
  it("exports writeProjectClassification", () => {
    expect(writeProjectClassification).toBeDefined()
  })
  it("exports validateFeatureRoutes", () => {
    expect(validateFeatureRoutes).toBeDefined()
  })
  it("exports getRouteRule", () => {
    expect(getRouteRule).toBeDefined()
  })
  it("exports resolveRouteRule", () => {
    expect(resolveRouteRule).toBeDefined()
  })
  it("exports checkClassificationVersion", () => {
    expect(checkClassificationVersion).toBeDefined()
  })
  it("exports upgradeClassificationConfig", () => {
    expect(upgradeClassificationConfig).toBeDefined()
  })
})
