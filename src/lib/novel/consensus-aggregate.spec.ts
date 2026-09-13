import { describe, expect, it } from "vitest"
import {
  aggregateReviewDimension,
  anonymousId,
  CONSENSUS_DISPUTE_THRESHOLD,
  pickBestDraft,
  type DebateBallot,
} from "./consensus-aggregate"

function ballot(id: string, score: number, summary = `summary-${id}`): DebateBallot {
  return { anonymousId: id, score, status: "pass", summary, issues: [] }
}

describe("anonymousId", () => {
  it("maps index to A/B/C codes", () => {
    expect(anonymousId(0)).toBe("A")
    expect(anonymousId(1)).toBe("B")
    expect(anonymousId(2)).toBe("C")
  })
})

describe("aggregateReviewDimension", () => {
  it("single ballot passes through (退化等价)", () => {
    const out = aggregateReviewDimension("thrill", [ballot("A", 8.5, "single")])
    expect(out.result.score).toBe(8.5)
    expect(out.result.summary).toBe("single")
    expect(out.disputed).toBe(false)
  })

  it("odd count takes the middle score", () => {
    const out = aggregateReviewDimension("thrill", [ballot("A", 6), ballot("B", 9), ballot("C", 8)])
    expect(out.result.score).toBe(8)
    expect(out.disputed).toBe(true) // spread 3 > 2
    expect(out.result.summary).toContain("共识分歧")
  })

  it("even count averages middle two to one decimal", () => {
    const out = aggregateReviewDimension("pacing", [ballot("A", 7), ballot("B", 8)])
    expect(out.result.score).toBe(7.5)
  })

  it("representative ballot is the one closest to median; issues carried over", () => {
    const withIssues = { ...ballot("B", 8), issues: [{ dimensionKey: "thrill" as const, severity: "warning" as const, type: "thrill" as const, message: "m", evidence: "e", relatedMemory: "", suggestion: "", impact: "i", rewriteTarget: "" }] }
    const out = aggregateReviewDimension("thrill", [ballot("A", 7.9), withIssues, ballot("C", 8.1)])
    expect(out.result.score).toBe(8)
    expect(out.result.issues).toHaveLength(1)
  })

  it("spread exactly at threshold is not disputed", () => {
    const out = aggregateReviewDimension("pull", [ballot("A", 7), ballot("B", 7 + CONSENSUS_DISPUTE_THRESHOLD)])
    expect(out.disputed).toBe(false)
  })
})

describe("pickBestDraft", () => {
  const candidates = [
    { anonymousId: "A", content: "draft-A" },
    { anonymousId: "B", content: "draft-B" },
    { anonymousId: "C", content: "draft-C" },
  ]

  it("picks highest average peer score excluding self-evaluation", () => {
    const evals = [
      { voter: "A", candidate: "B", score: 9, rationale: "r-B1" },
      { voter: "C", candidate: "B", score: 8, rationale: "r-B2" },
      { voter: "B", candidate: "A", score: 6, rationale: "r-A1" },
      { voter: "C", candidate: "A", score: 7, rationale: "r-A2" },
      { voter: "A", candidate: "C", score: 5, rationale: "r-C1" },
      { voter: "B", candidate: "C", score: 9.6, rationale: "r-C2" },
    ]
    const out = pickBestDraft(candidates, evals)
    // A 平均 6.5，B 平均 8.5（排除 B 自评 A？否——排除的是 candidate===voter）
    expect(out.winner.anonymousId).toBe("B")
    expect(out.winner.content).toBe("draft-B")
    expect(out.rationaleDigest).toContain("r-B1")
  })

  it("self-evaluation does not count", () => {
    const evals = [
      { voter: "A", candidate: "A", score: 10, rationale: "self" },
      { voter: "B", candidate: "A", score: 4, rationale: "peer" },
    ]
    const out = pickBestDraft(candidates.slice(0, 1), evals)
    expect(out.averageScores[0]!.average).toBe(4)
  })

  it("tie breaks deterministically to first candidate in array order", () => {
    const two = [
      { anonymousId: "A", content: "dA" },
      { anonymousId: "B", content: "dB" },
    ]
    const evals = [
      { voter: "B", candidate: "A", score: 8, rationale: "" },
      { voter: "A", candidate: "B", score: 8, rationale: "" },
    ]
    const out = pickBestDraft(two, evals)
    expect(out.winner.anonymousId).toBe("A")
  })

  it("no evaluations → all zero averages, first candidate wins", () => {
    const out = pickBestDraft(candidates, [])
    expect(out.winner.anonymousId).toBe("A")
    expect(out.averageScores.every((a) => a.average === 0)).toBe(true)
  })
})
