import { describe, expect, it } from "vitest"
import { projectActiveEdges } from "./graph-projection"
import { createFactRecord } from "./fact-model"

describe("graph-projection projectActiveEdges", () => {
  it("maps verified facts into active graph edges", () => {
    const edges = projectActiveEdges([
      createFactRecord({
        fact_id: "fact:1",
        subject_id: "entity:alice",
        predicate: "loves",
        object_id_or_value: "entity:bob",
        canon_status: "verified",
      }),
      createFactRecord({ fact_id: "fact:2", canon_status: "candidate" }),
    ])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({
      fact_id: "fact:1",
      source: "entity:alice",
      relation: "loves",
      target: "entity:bob",
      active: true,
    })
  })

  it("returns empty array when nothing is verified", () => {
    expect(projectActiveEdges([])).toEqual([])
    expect(
      projectActiveEdges([createFactRecord({ canon_status: "rejected" })]),
    ).toEqual([])
  })
})
