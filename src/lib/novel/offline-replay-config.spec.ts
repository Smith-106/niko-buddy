/** C4 冒烟覆盖：src/lib/novel/offline-replay-config.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { OFFLINE_REPLAY_FACTOR_WEIGHTS, OFFLINE_REPLAY_WEIGHT_SUM, OFFLINE_REPLAY_THRESHOLDS, OFFLINE_REPLAY_QUALITY_THRESHOLD, OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS, REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS, normalizeWallClock, buildDecisionLogEntry, scoreReplay, replayStates, OFFLINE_REPLAY_AB_SEED, OFFLINE_REPLAY_AB_BOOTSTRAP_RESAMPLES, OFFLINE_REPLAY_AB_MIN_MEDIAN_DIFF, OFFLINE_REPLAY_AB_CI_CONFIDENCE, EVAL_GATE, abLcgNext, medianOf, computePairedMedianDiffStats } from "./offline-replay-config"
describe("offline-replay-config.ts smoke", () => {
  it("exports OFFLINE_REPLAY_FACTOR_WEIGHTS", () => {
    expect(OFFLINE_REPLAY_FACTOR_WEIGHTS).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_WEIGHT_SUM", () => {
    expect(OFFLINE_REPLAY_WEIGHT_SUM).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_THRESHOLDS", () => {
    expect(OFFLINE_REPLAY_THRESHOLDS).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_QUALITY_THRESHOLD", () => {
    expect(OFFLINE_REPLAY_QUALITY_THRESHOLD).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS", () => {
    expect(OFFLINE_REPLAY_WALLCLOCK_REFERENCE_SECONDS).toBeDefined()
  })
  it("exports REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS", () => {
    expect(REBASE_REQUIRED_WHEN_WEIGHT_DRIFTS).toBeDefined()
  })
  it("exports normalizeWallClock", () => {
    expect(normalizeWallClock).toBeDefined()
  })
  it("exports buildDecisionLogEntry", () => {
    expect(buildDecisionLogEntry).toBeDefined()
  })
  it("exports scoreReplay", () => {
    expect(scoreReplay).toBeDefined()
  })
  it("exports replayStates", () => {
    expect(replayStates).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_AB_SEED", () => {
    expect(OFFLINE_REPLAY_AB_SEED).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_AB_BOOTSTRAP_RESAMPLES", () => {
    expect(OFFLINE_REPLAY_AB_BOOTSTRAP_RESAMPLES).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_AB_MIN_MEDIAN_DIFF", () => {
    expect(OFFLINE_REPLAY_AB_MIN_MEDIAN_DIFF).toBeDefined()
  })
  it("exports OFFLINE_REPLAY_AB_CI_CONFIDENCE", () => {
    expect(OFFLINE_REPLAY_AB_CI_CONFIDENCE).toBeDefined()
  })
  it("exports EVAL_GATE", () => {
    expect(EVAL_GATE).toBeDefined()
  })
  it("exports abLcgNext", () => {
    expect(abLcgNext).toBeDefined()
  })
  it("exports medianOf", () => {
    expect(medianOf).toBeDefined()
  })
  it("exports computePairedMedianDiffStats", () => {
    expect(computePairedMedianDiffStats).toBeDefined()
  })
})
