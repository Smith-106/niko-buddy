/**
 * auto-arm-status.spec — 波2-A draft-autoarm → status.json 契约接线测试。
 * 覆盖：armed → target ready / 未 armed → null / 补丁 draft_status /
 * assert 拒 accept 语义 / apply 仅 pending→ready 且不覆盖人工裁定 /
 * validateAndBackfill 往返保留 draft_auto_arm / 旧 status 无字段可加载。
 */
import { describe, expect, it } from "vitest"
import {
  AutoArmStatusError,
  DRAFT_AUTO_ARM_SCHEMA,
  applyDraftAutoArmPatch,
  assertAutoArmPatchNeverAccepts,
  buildDraftAutoArmPatch,
  buildDraftAutoArmRecord,
} from "./auto-arm-status"
import { evaluateDraftAutoArm } from "./director-modes"
import { validateAndBackfillNovelSessionStatus } from "./novel-session-status"

const GATE_SNAPSHOT = {
  consistency: "pass" as const,
  anti_ai: "pass" as const,
  quality: "pass" as const,
}

const ARMED_DECISION = {
  armed: true as const,
  target: "ready" as const,
  reason: "all_required_gates_pass",
  gateSnapshot: GATE_SNAPSHOT,
}

const UNARMED_DECISION = {
  armed: false as const,
  target: null,
  reason: "gate_failed:consistency",
  gateSnapshot: { consistency: "fail" as const, anti_ai: "pass" as const, quality: "pass" as const },
}

function minimalStatus(
  draftStatus: string,
): {
  draft: { draft_status: string } & Record<string, unknown>
} & Record<string, unknown> {
  return {
    schema_version: "1",
    session_id: "s-1",
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
    status: "running",
    active_step_index: null,
    current_task: { conversation_id: "c-1", user_request: "写第一章", status: "running" },
    draft: { draft_id: "d-1", file_path: "drafts/d-1.md", draft_status: draftStatus },
  }
}

describe("buildDraftAutoArmRecord（裁定 → 落盘记录）", () => {
  it("armed → record.target 恒 ready 且通过 zod strict", () => {
    const record = buildDraftAutoArmRecord(ARMED_DECISION, "2026-09-16T00:00:00.000Z")
    expect(record.armed).toBe(true)
    expect(record.target).toBe("ready")
    expect(DRAFT_AUTO_ARM_SCHEMA.safeParse(record).success).toBe(true)
  })

  it("未 armed → target 恒 null（fail 快照随行）", () => {
    const record = buildDraftAutoArmRecord(UNARMED_DECISION, "2026-09-16T00:00:00.000Z")
    expect(record.armed).toBe(false)
    expect(record.target).toBeNull()
    expect(record.gateSnapshot.consistency).toBe("fail")
  })

  it("armed 但 target 缺失 → AutoArmStatusError（裁定不一致拒绝）", () => {
    expect(() =>
      buildDraftAutoArmRecord({ ...ARMED_DECISION, target: null as unknown as "ready" }, "t"),
    ).toThrow(AutoArmStatusError)
  })
})

describe("buildDraftAutoArmPatch（落盘记录 → 补丁）", () => {
  it("armed → draft_status ready；未 armed → null（不碰草稿态）", () => {
    const armed = buildDraftAutoArmPatch(buildDraftAutoArmRecord(ARMED_DECISION, "t"))
    expect(armed.draft_status).toBe("ready")
    const unarmed = buildDraftAutoArmPatch(buildDraftAutoArmRecord(UNARMED_DECISION, "t"))
    expect(unarmed.draft_status).toBeNull()
  })

  it("手搓脏对象入参 → zod strict 拒绝", () => {
    expect(() =>
      buildDraftAutoArmPatch({ armed: true, target: "ready", reason: "x", decidedAt: "t", gateSnapshot: GATE_SNAPSHOT, extra: 1 } as never),
    ).toThrow()
  })
})

describe("assertAutoArmPatchNeverAccepts（accept 语义深扫）", () => {
  it("补丁含嵌套 accepted 字符串 → 抛 AutoArmStatusError", () => {
    expect(() =>
      assertAutoArmPatchNeverAccepts({
        draft_auto_arm: { armed: true, target: "ready", reason: "x", decidedAt: "t", gateSnapshot: GATE_SNAPSHOT },
        nested: { draft_status: "accepted" },
      }),
    ).toThrow(AutoArmStatusError)
    expect(() => assertAutoArmPatchNeverAccepts(["accepted"])).toThrow(AutoArmStatusError)
  })

  it("合法 ready 补丁通过", () => {
    const patch = buildDraftAutoArmPatch(buildDraftAutoArmRecord(ARMED_DECISION, "t"))
    expect(() => assertAutoArmPatchNeverAccepts(patch)).not.toThrow()
  })
})

describe("applyDraftAutoArmPatch（status.json 补丁应用）", () => {
  it("pending → ready（机械门全 pass 升 ready，非 accept）", () => {
    const patch = buildDraftAutoArmPatch(buildDraftAutoArmRecord(ARMED_DECISION, "t"))
    const next = applyDraftAutoArmPatch(minimalStatus("pending"), patch)
    expect(next.draft.draft_status).toBe("ready")
    expect(next.draft_auto_arm?.target).toBe("ready")
  })

  it("ready/accepted/rejected/superseded 现态原样保留（autoarm 永不覆盖人工裁定）", () => {
    const patch = buildDraftAutoArmPatch(buildDraftAutoArmRecord(ARMED_DECISION, "t"))
    for (const status of ["ready", "accepted", "rejected", "superseded"]) {
      const next = applyDraftAutoArmPatch(minimalStatus(status), patch)
      expect(next.draft.draft_status).toBe(status)
    }
  })

  it("未 armed 补丁不碰草稿态；draft_auto_arm 恒写入", () => {
    const patch = buildDraftAutoArmPatch(buildDraftAutoArmRecord(UNARMED_DECISION, "t"))
    const next = applyDraftAutoArmPatch(minimalStatus("pending"), patch)
    expect(next.draft.draft_status).toBe("pending")
    expect(next.draft_auto_arm?.armed).toBe(false)
    expect(next.draft_auto_arm?.target).toBeNull()
  })

  it("补丁含 accept 语义 → 抛错拒绝应用", () => {
    expect(() =>
      applyDraftAutoArmPatch(minimalStatus("pending"), {
        draft_auto_arm: buildDraftAutoArmRecord(ARMED_DECISION, "t"),
        draft_status: "accepted" as never,
      }),
    ).toThrow(AutoArmStatusError)
  })
})

describe("status.json 加载边界（additive 兼容）", () => {
  it("validateAndBackfill 往返保留 draft_auto_arm", () => {
    const record = buildDraftAutoArmRecord(ARMED_DECISION, "2026-09-16T00:00:00.000Z")
    const raw = { ...minimalStatus("ready"), draft_auto_arm: record }
    const parsed = validateAndBackfillNovelSessionStatus(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.draft_auto_arm?.target).toBe("ready")
    expect(parsed?.draft_auto_arm?.armed).toBe(true)
  })

  it("旧 status.json 无 draft_auto_arm 字段照常加载（additive 兼容）", () => {
    const parsed = validateAndBackfillNovelSessionStatus(minimalStatus("pending"))
    expect(parsed).not.toBeNull()
    expect(parsed?.draft_auto_arm).toBeUndefined()
  })

  it("draft_auto_arm 形状违反（target 非 ready/null）→ 加载边界拒绝", () => {
    const raw = {
      ...minimalStatus("ready"),
      draft_auto_arm: { armed: true, target: "accepted", reason: "x", decidedAt: "t", gateSnapshot: GATE_SNAPSHOT },
    }
    expect(validateAndBackfillNovelSessionStatus(raw)).toBeNull()
  })
})

describe("director-modes 联动（evaluate → record 端到端）", () => {
  it("evaluateDraftAutoArm armed 裁定可直接落盘；policy off 不 arm", () => {
    const armed = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: ["consistency", "anti_ai"] },
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "skipped" },
    })
    const record = buildDraftAutoArmRecord(armed, "t")
    expect(record.target).toBe("ready")
    const off = evaluateDraftAutoArm({
      policy: { enabled: false, requiredGates: ["consistency", "anti_ai"] },
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
    })
    expect(off.armed).toBe(false)
  })
})