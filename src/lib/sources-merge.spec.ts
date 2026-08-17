import { describe, expect, it } from "vitest"
import {
  mergeArrayFieldsIntoContent,
  mergeSourcesIntoContent,
  mergeSourcesLists,
  parseFrontmatterArray,
  parseSources,
  writeFrontmatterArray,
  writeSources,
} from "./sources-merge"

describe("parseFrontmatterArray", () => {
  it("returns an empty array when there is no frontmatter block", () => {
    expect(parseFrontmatterArray("plain text", "sources")).toEqual([])
  })

  it("returns an empty array when the field is absent", () => {
    const content = "---\ntitle: x\n---\nbody"
    expect(parseFrontmatterArray(content, "sources")).toEqual([])
  })

  it("parses an inline array", () => {
    const content = '---\nsources: ["a", "b"]\n---\n'
    expect(parseFrontmatterArray(content, "sources")).toEqual(["a", "b"])
  })

  it("parses an inline array with unquoted values", () => {
    const content = "---\nsources: [a, b, c]\n---\n"
    expect(parseFrontmatterArray(content, "sources")).toEqual(["a", "b", "c"])
  })

  it("parses a block-form array", () => {
    const content = "---\nsources:\n  - alpha\n  - beta\n---\n"
    expect(parseFrontmatterArray(content, "sources")).toEqual(["alpha", "beta"])
  })

  it("returns an empty array for an empty inline array", () => {
    const content = "---\nsources: []\n---\n"
    expect(parseFrontmatterArray(content, "sources")).toEqual([])
  })

  it("returns an empty array for an empty block form", () => {
    const content = "---\nsources:\n---\n"
    expect(parseFrontmatterArray(content, "sources")).toEqual([])
  })

  it("skips empty tail lines produced by the block capture", () => {
    const content = "---\nsources:\n  - alpha\n\ntitle: x\n---\n"
    expect(parseFrontmatterArray(content, "sources")).toEqual(["alpha"])
  })

  it("treats regex-special field names literally", () => {
    const content = '---\nsources: ["x"]\n---\n'
    expect(parseFrontmatterArray(content, "a.b")).toEqual([])
  })
})

describe("writeFrontmatterArray", () => {
  const base = "---\ntitle: x\n---\nbody"

  it("returns content unchanged when there is no frontmatter", () => {
    expect(writeFrontmatterArray("no fm", "sources", ["a"])).toBe("no fm")
  })

  it("replaces an existing inline field in place", () => {
    const content = '---\nsources: ["old"]\n---\nbody'
    expect(writeFrontmatterArray(content, "sources", ["a", "b"])).toBe(
      '---\nsources: ["a", "b"]\n---\nbody',
    )
  })

  it("normalises an existing block field to inline form", () => {
    const content = "---\nsources:\n  - old\n  - older\n---\nbody"
    expect(writeFrontmatterArray(content, "sources", ["a"])).toBe(
      '---\nsources: ["a"]\n---\nbody',
    )
  })

  it("appends the field when absent", () => {
    expect(writeFrontmatterArray(base, "sources", ["a"])).toBe(
      '---\ntitle: x\nsources: ["a"]\n---\nbody',
    )
  })

  it("appends an empty array as an empty inline field", () => {
    expect(writeFrontmatterArray(base, "related", [])).toBe(
      "---\ntitle: x\nrelated: []\n---\nbody",
    )
  })

  it("writes an empty value list with just quotes serialisation intact", () => {
    expect(writeFrontmatterArray(base, "sources", [])).toBe(
      "---\ntitle: x\nsources: []\n---\nbody",
    )
  })
})

describe("parseSources / writeSources", () => {
  it("parses the sources field", () => {
    const content = '---\nsources: ["a"]\n---\n'
    expect(parseSources(content)).toEqual(["a"])
  })

  it("writes the sources field into existing frontmatter", () => {
    expect(writeSources("---\ntitle: x\n---\n", ["x"])).toBe(
      '---\ntitle: x\nsources: ["x"]\n---\n',
    )
  })

  it("replaces an existing sources field", () => {
    expect(writeSources('---\nsources: ["old"]\n---\n', ["x"])).toBe(
      '---\nsources: ["x"]\n---\n',
    )
  })
})

describe("mergeSourcesLists", () => {
  it("unions with case-insensitive dedup, preserving first-seen casing", () => {
    expect(mergeSourcesLists(["Alpha", "beta"], ["BETA", "gamma"])).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ])
  })

  it("handles empty inputs", () => {
    expect(mergeSourcesLists([], [])).toEqual([])
    expect(mergeSourcesLists(["a"], [])).toEqual(["a"])
    expect(mergeSourcesLists([], ["a"])).toEqual(["a"])
  })
})

describe("mergeArrayFieldsIntoContent", () => {
  it("returns newContent unchanged when existing content is null", () => {
    const nc = '---\nsources: ["a"]\n---\n'
    expect(mergeArrayFieldsIntoContent(nc, null, ["sources"])).toBe(nc)
  })

  it("returns newContent unchanged when existing content lacks frontmatter", () => {
    const nc = '---\nsources: ["a"]\n---\n'
    expect(mergeArrayFieldsIntoContent(nc, "no frontmatter", ["sources"])).toBe(nc)
  })

  it("merges existing sources into the new content", () => {
    const existing = '---\nsources: ["a", "b"]\n---\n'
    const fresh = '---\nsources: ["b", "c"]\n---\n'
    expect(mergeArrayFieldsIntoContent(fresh, existing, ["sources"])).toBe(
      '---\nsources: ["a", "b", "c"]\n---\n',
    )
  })

  it("returns the stable reference when nothing changed", () => {
    const existing = '---\nsources: ["a"]\n---\n'
    const fresh = '---\nsources: ["a"]\n---\n'
    expect(mergeArrayFieldsIntoContent(fresh, existing, ["sources"])).toBe(fresh)
  })

  it("skips fields with no existing values", () => {
    const existing = "---\ntitle: x\n---\n"
    const fresh = '---\nsources: ["a"]\n---\n'
    expect(mergeArrayFieldsIntoContent(fresh, existing, ["sources"])).toBe(fresh)
  })

  it("merges multiple fields at once", () => {
    const existing = '---\nsources: ["old"]\ntags: ["t1"]\n---\n'
    const fresh = '---\nsources: ["new"]\ntags: ["t2"]\n---\n'
    const result = mergeArrayFieldsIntoContent(fresh, existing, ["sources", "tags"])
    expect(parseFrontmatterArray(result, "sources")).toEqual(["old", "new"])
    expect(parseFrontmatterArray(result, "tags")).toEqual(["t1", "t2"])
  })

  it("merges newContent that lacks the field by appending it", () => {
    const existing = '---\nsources: ["a"]\n---\n'
    const fresh = "---\ntitle: fresh\n---\n"
    const result = mergeArrayFieldsIntoContent(fresh, existing, ["sources"])
    expect(parseFrontmatterArray(result, "sources")).toEqual(["a"])
  })
})

describe("mergeSourcesIntoContent", () => {
  it("merges only the sources field", () => {
    const existing = '---\nsources: ["a"]\n---\n'
    const fresh = '---\nsources: ["b"]\n---\n'
    expect(mergeSourcesIntoContent(fresh, existing)).toBe('---\nsources: ["a", "b"]\n---\n')
  })
})
