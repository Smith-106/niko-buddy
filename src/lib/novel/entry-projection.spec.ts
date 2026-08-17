import { describe, expect, it } from "vitest"
import { projectVerifiedEntries } from "./entry-projection"
import { createFactRecord } from "./fact-model"

describe("entry-projection projectVerifiedEntries", () => {
  it("keeps only verified facts", () => {
    const facts = [
      createFactRecord({ fact_id: "a", canon_status: "verified" }),
      createFactRecord({ fact_id: "b", canon_status: "candidate" }),
      createFactRecord({ fact_id: "c", canon_status: "verified" }),
      createFactRecord({ fact_id: "d", canon_status: "rejected" }),
      createFactRecord({ fact_id: "e", canon_status: "pending_review" }),
    ]
    const projected = projectVerifiedEntries(facts)
    expect(projected.map((f) => f.fact_id)).toEqual(["a", "c"])
  })

  it("returns empty array for no verified facts", () => {
    expect(projectVerifiedEntries([])).toEqual([])
    expect(
      projectVerifiedEntries([createFactRecord({ canon_status: "candidate" })]),
    ).toEqual([])
  })

  it("does not mutate the input array", () => {
    const facts = [
      createFactRecord({ fact_id: "a", canon_status: "verified" }),
      createFactRecord({ fact_id: "b", canon_status: "candidate" }),
    ]
    const projected = projectVerifiedEntries(facts)
    expect(facts).toHaveLength(2)
    expect(projected).toHaveLength(1)
  })
})
