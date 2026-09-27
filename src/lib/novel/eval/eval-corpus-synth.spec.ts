/** C4 冒烟覆盖：src/lib/novel/eval/eval-corpus-synth.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { EVAL_SCENARIOS, SYNTH_CASE_COUNT, SYNTH_HOLDOUT_RATIO, synthCase, synthCorpus } from "./eval-corpus-synth"
describe("eval-corpus-synth.ts smoke", () => {
  it("exports EVAL_SCENARIOS", () => {
    expect(EVAL_SCENARIOS).toBeDefined()
  })
  it("exports SYNTH_CASE_COUNT", () => {
    expect(SYNTH_CASE_COUNT).toBeDefined()
  })
  it("exports SYNTH_HOLDOUT_RATIO", () => {
    expect(SYNTH_HOLDOUT_RATIO).toBeDefined()
  })
  it("exports synthCase", () => {
    expect(synthCase).toBeDefined()
  })
  it("synthCorpus() executes", async () => {
    await (synthCorpus() as unknown as Promise<unknown>)
  })
})
