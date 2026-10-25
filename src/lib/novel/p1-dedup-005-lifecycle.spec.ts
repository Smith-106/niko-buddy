import { describe, expect, it } from "vitest"
import {
  buildLifecycleStatus,
  buildNextStatus,
} from "@/lib/novel/novel-session-status"

/**
 * ISS-20260709-005/027：7 lifecycle 孪生收敛到 buildLifecycleStatus 工厂。
 * 字段仍 8 个全保留（行为等价：别名同一函数）。
 */
describe("ISS-20260709-005/027 lifecycle factory convergence", () => {
  it("buildLifecycleStatus 与 buildNextStatus 为同一工厂（别名）", () => {
    expect(buildLifecycleStatus).toBe(buildNextStatus)
  })

  it("8 核心字段全保留且 delta-only 透传", () => {
    const base = {
      schema_version: 1,
      session_id: "s1",
      source: "test",
      created_at: "c0",
      updated_at: "t0",
      status: "running",
      active_step_index: 1,
      current_task: { status: "running" },
      draft: {},
      decision_gates: { overall: "pending" },
      resume_checkpoint: undefined,
      evidence_refs: ["e0"],
      dimension_results: undefined,
      stage_metrics: [],
      review_job: undefined,
      chase_debt: undefined,
      de_ai_batch: undefined,
      step_digest: undefined,
      route_shell_mode: undefined,
      canon_migration: undefined,
      anti_ai_mode: undefined,
    } as unknown as Parameters<typeof buildLifecycleStatus>[0]
    const next = buildLifecycleStatus(base, {
      updated_at: "t1",
      status: "paused",
      active_step_index: 2,
      current_task: { status: "paused" },
      draft: { draft_status: "pending" },
      resume_checkpoint: undefined,
      evidence_refs: ["e0", "e1"],
    } as unknown as Parameters<typeof buildLifecycleStatus>[1])
    // 8 字段：updated_at/status/active_step_index/current_task/draft/decision_gates/resume_checkpoint/evidence_refs
    expect(next.updated_at).toBe("t1")
    expect(next.status).toBe("paused")
    expect(next.active_step_index).toBe(2)
    expect(next.evidence_refs).toEqual(["e0", "e1"])
    // 未传 decision_gates 时继承 base（delta-only）
    expect(next.decision_gates).toEqual(base.decision_gates)
    // 身份字段守恒
    expect(next.session_id).toBe("s1")
  })
});
