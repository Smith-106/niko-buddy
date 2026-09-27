/** C4 冒烟覆盖：src/lib/llm/model-resolver.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ALL_WRITING_ROLES, resolveRoleModel, buildRoleModelMap, buildDefaultRoleModelMap, ALL_TASK_TIERS, resolveTierModel, resolveTierRole, DEFAULT_JUDGE_POOL, resolveJudgePool, resolveJudgePair, resolveFallbackChain, isRetryableError, isContentError, NovelError, RetryableError, ContentError, FatalError, classifyError } from "./model-resolver"
describe("model-resolver.ts smoke", () => {
  it("exports ALL_WRITING_ROLES", () => {
    expect(ALL_WRITING_ROLES).toBeDefined()
  })
  it("exports resolveRoleModel", () => {
    expect(resolveRoleModel).toBeDefined()
  })
  it("exports buildRoleModelMap", () => {
    expect(buildRoleModelMap).toBeDefined()
  })
  it("exports buildDefaultRoleModelMap", () => {
    expect(buildDefaultRoleModelMap).toBeDefined()
  })
  it("exports ALL_TASK_TIERS", () => {
    expect(ALL_TASK_TIERS).toBeDefined()
  })
  it("exports resolveTierModel", () => {
    expect(resolveTierModel).toBeDefined()
  })
  it("exports resolveTierRole", () => {
    expect(resolveTierRole).toBeDefined()
  })
  it("exports DEFAULT_JUDGE_POOL", () => {
    expect(DEFAULT_JUDGE_POOL).toBeDefined()
  })
  it("exports resolveJudgePool", () => {
    expect(resolveJudgePool).toBeDefined()
  })
  it("exports resolveJudgePair", () => {
    expect(resolveJudgePair).toBeDefined()
  })
  it("exports resolveFallbackChain", () => {
    expect(resolveFallbackChain).toBeDefined()
  })
  it("exports isRetryableError", () => {
    expect(isRetryableError).toBeDefined()
  })
  it("exports isContentError", () => {
    expect(isContentError).toBeDefined()
  })
  it("exports NovelError", () => {
    expect(NovelError).toBeDefined()
  })
  it("exports RetryableError", () => {
    expect(RetryableError).toBeDefined()
  })
  it("exports ContentError", () => {
    expect(ContentError).toBeDefined()
  })
  it("exports FatalError", () => {
    expect(FatalError).toBeDefined()
  })
  it("exports classifyError", () => {
    expect(classifyError).toBeDefined()
  })
})
