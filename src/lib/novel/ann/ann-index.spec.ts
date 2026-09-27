/** C4 冒烟覆盖：src/lib/novel/ann/ann-index.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { AnnIndexError, ANN_INDEX_TYPE_SCHEMA, ANN_METRIC_SCHEMA, ANN_VECTOR_SCHEMA, ANN_QUERY_SCHEMA, ANN_HIT_SCHEMA, ANN_DESCRIPTOR_SCHEMA, recallAtK, withInjectedClock } from "./ann-index"
describe("ann-index.ts smoke", () => {
  it("exports AnnIndexError", () => {
    expect(AnnIndexError).toBeDefined()
  })
  it("exports ANN_INDEX_TYPE_SCHEMA", () => {
    expect(ANN_INDEX_TYPE_SCHEMA).toBeDefined()
  })
  it("exports ANN_METRIC_SCHEMA", () => {
    expect(ANN_METRIC_SCHEMA).toBeDefined()
  })
  it("exports ANN_VECTOR_SCHEMA", () => {
    expect(ANN_VECTOR_SCHEMA).toBeDefined()
  })
  it("exports ANN_QUERY_SCHEMA", () => {
    expect(ANN_QUERY_SCHEMA).toBeDefined()
  })
  it("exports ANN_HIT_SCHEMA", () => {
    expect(ANN_HIT_SCHEMA).toBeDefined()
  })
  it("exports ANN_DESCRIPTOR_SCHEMA", () => {
    expect(ANN_DESCRIPTOR_SCHEMA).toBeDefined()
  })
  it("exports recallAtK", () => {
    expect(recallAtK).toBeDefined()
  })
  it("exports withInjectedClock", () => {
    expect(withInjectedClock).toBeDefined()
  })
})
