import { describe, expect, it } from "vitest"
import { shouldHideEdgeByNodeTypes, shouldHideNodeType } from "./graph-visibility"

describe("shouldHideNodeType", () => {
  it("hides a node whose type is in the hidden set", () => {
    expect(shouldHideNodeType("outline", new Set(["outline", "source"]))).toBe(true)
  })

  it("keeps a node whose type is not in the hidden set", () => {
    expect(shouldHideNodeType("character", new Set(["outline", "source"]))).toBe(false)
  })

  it("keeps an undefined node type", () => {
    expect(shouldHideNodeType(undefined, new Set(["outline"]))).toBe(false)
  })

  it("keeps a node when the hidden set is empty", () => {
    expect(shouldHideNodeType("anything", new Set())).toBe(false)
  })
})

describe("shouldHideEdgeByNodeTypes", () => {
  const hidden = new Set(["outline"])

  it("hides the edge when the source type is hidden", () => {
    expect(shouldHideEdgeByNodeTypes("outline", "chapter", hidden)).toBe(true)
  })

  it("hides the edge when the target type is hidden", () => {
    expect(shouldHideEdgeByNodeTypes("chapter", "outline", hidden)).toBe(true)
  })

  it("keeps the edge when neither endpoint is hidden", () => {
    expect(shouldHideEdgeByNodeTypes("chapter", "character", hidden)).toBe(false)
  })

  it("keeps the edge when both endpoint types are undefined", () => {
    expect(shouldHideEdgeByNodeTypes(undefined, undefined, hidden)).toBe(false)
  })
})
