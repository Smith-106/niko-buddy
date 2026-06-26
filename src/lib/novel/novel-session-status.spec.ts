import { describe, expect, it } from "vitest"
import { DraftStatus } from "./draft-state-machine"
import {
  applyDeepSessionStatus,
  createEmptyStatusSchema,
  explainDeepSessionStatus,
  shouldResetStatusSchema,
} from "./novel-session-status"
import type { GateSummary } from "@/commands/gates"

function createGateSummary(): GateSummary {
  return {
    all_passed: false,
    gate_results: {
      consistency: {
        gate_type: "consistency",
        status: "failed",
        score: 61,
        finding_count: 1,
        retry_count: 2,
        mechanical_findings: [{ severity: "error", description: "timeline conflict", location: "paragraph 2", suggestion: "repair chronology" }],
        semantic_findings: [],
        findings_desc: ["- [error] timeline conflict"],
      },
      anti_ai: {
        gate_type: "anti_ai",
        status: "passed",
        score: 96,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      quality: {
        gate_type: "quality",
        status: "warning",
        score: 82,
        finding_count: 1,
        retry_count: 0,
        mechanical_findings: [{ severity: "warning", description: "sentence slightly long", location: null, suggestion: "split one sentence" }],
        semantic_findings: [],
        findings_desc: ["- [warning] sentence slightly long"],
      },
    },
    total_retries: 2,
    max_retry: 3,
    final_text: null,
  }
}

function createPassingCompletedGateSummary(): GateSummary {
  return {
    all_passed: true,
    gate_results: {
      consistency: {
        gate_type: "consistency",
        status: "passed",
        score: 100,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      anti_ai: {
        gate_type: "anti_ai",
        status: "passed",
        score: 97,
        finding_count: 0,
        retry_count: 0,
        mechanical_findings: [],
        semantic_findings: [],
        findings_desc: [],
      },
      quality: {
        gate_type: "quality",
        status: "warning",
        score: 84,
        finding_count: 1,
        retry_count: 0,
        mechanical_findings: [{ severity: "warning", description: "style note", location: null, suggestion: "trim one phrase" }],
        semantic_findings: [],
        findings_desc: ["- [warning] style note"],
      },
    },
    total_retries: 0,
    max_retry: 3,
    final_text: null,
  }
}

describe("novel-session-status", () => {
  it("creates a default status schema with draft-first boundaries", () => {
    const schema = createEmptyStatusSchema()

    expect(schema.schema_version).toBe("1")
    expect(schema.source).toBe("qmai")
    expect(schema.status).toBe("running")
    expect(schema.active_step_index).toBe(0)
    expect(schema.session_id).toMatch(/^novel-\d{8}-\d{6}$/)
    expect(schema.boundary_contract).toMatchObject({
      single_source_of_truth: ".novel/status.json",
      draft_first: true,
      gate_priority: ["consistency", "anti_ai", "quality"],
    })
    expect(schema.task_decomposition).toHaveLength(6)
    expect(schema.decision_gates.consistency.status).toBe("pending")
    expect(schema.decision_gates.anti_ai.status).toBe("pending")
    expect(schema.decision_gates.quality.status).toBe("pending")
  })

  it("updates active step and draft payload after draft generation", () => {
    const current = createEmptyStatusSchema()
    const next = applyDeepSessionStatus(current, {
      projectPath: "C:/test/project",
      conversationId: "conv-draft",
      userRequest: "Generate chapter 3",
      chapterNumber: 3,
      draftStatus: DraftStatus.Ready,
      stage: "after_draft",
      checkpoint: {
        version: 1,
        originalRequest: "Generate chapter 3",
        taskId: "tsk-ch003-conv-draft",
        chapterNumber: 3,
        stage: "after_draft",
        taskBrief: "Advance the key clue without breaking cognition boundaries.",
        draftContent: "Draft body for chapter 3.",
        currentContent: "Draft body for chapter 3.",
      },
      sessionStatus: "running",
    })

    expect(next.status).toBe("running")
    expect(next.active_step_index).toBe(2)
    expect(next.current_task).toBe("tsk-ch003-conv-draft")
    expect(next.task_decomposition[0]).toMatchObject({ status: "done" })
    expect(next.task_decomposition[1]).toMatchObject({ status: "done" })
    expect(next.task_decomposition[2]).toMatchObject({ status: "running" })
    expect(next.draft).toMatchObject({
      draft_id: "conv-draft-draft",
      draft_status: "ready",
      conversation_id: "conv-draft",
      source_task_id: "tsk-ch003-conv-draft",
      chapter_number: 3,
      task_brief: "Advance the key clue without breaking cognition boundaries.",
      draft_content: "Draft body for chapter 3.",
      final_content: "Draft body for chapter 3.",
    })
  })

  it("marks the session completed and stores final content", () => {
    const current = createEmptyStatusSchema()
    const next = applyDeepSessionStatus(current, {
      projectPath: "C:/test/project",
      conversationId: "conv-completed",
      userRequest: "Generate chapter 3",
      chapterNumber: 3,
      draftStatus: DraftStatus.Ready,
      stage: "completed",
      sessionStatus: "completed",
      finalContent: "Final polished chapter body.",
      checkpoint: {
        version: 1,
        originalRequest: "Generate chapter 3",
        taskId: "tsk-ch003-conv-completed",
        chapterNumber: 3,
        stage: "after_revision",
        taskBrief: "Keep the timeline clean and land the hook.",
        draftContent: "Revised chapter draft.",
        currentContent: "Final polished chapter body.",
        gateSummary: createPassingCompletedGateSummary(),
      },
    })

    expect(next.status).toBe("completed")
    expect(next.active_step_index).toBe(5)
    expect(next.task_decomposition.every((step) => (step as { status: string }).status === "done")).toBe(true)
    expect(next.draft).toMatchObject({
      draft_status: "ready",
      final_content: "Final polished chapter body.",
    })
    expect(next.memory_snapshot).toMatchObject({
      latest_final_content: "Final polished chapter body.",
    })
    expect(next.evidence_refs).toContain("runs/tsk-ch003-conv-completed-gates.json")
    expect(next.evidence_refs).toContain("drafts/tsk-ch003-conv-completed.json")
  })

  it("drops stale review error records when completed gates no longer fail", () => {
    const current = createEmptyStatusSchema()
    const next = applyDeepSessionStatus(current, {
      projectPath: "C:/test/project",
      conversationId: "conv-align",
      userRequest: "Generate chapter 3",
      chapterNumber: 3,
      draftStatus: DraftStatus.Ready,
      stage: "completed",
      sessionStatus: "completed",
      finalContent: "Final polished chapter body.",
      checkpoint: {
        version: 1,
        originalRequest: "Generate chapter 3",
        taskId: "tsk-ch003-conv-align",
        chapterNumber: 3,
        stage: "after_revision",
        taskBrief: "Finish the chapter cleanly.",
        draftContent: "Revised chapter draft.",
        currentContent: "Final polished chapter body.",
        reviewResults: [
          {
            severity: "error",
            type: "consistency",
            message: "timeline conflict still reported in stale review",
          },
          {
            severity: "warning",
            type: "style",
            message: "trim one descriptive phrase",
          },
        ],
        gateSummary: createPassingCompletedGateSummary(),
      },
    })

    expect(next.decision_gates.consistency.status).toBe("passed")
    expect(next.decision_gates.anti_ai.status).toBe("passed")
    expect(next.decision_gates.quality.status).toBe("warning")
    expect(next.draft).toMatchObject({
      review_results: [
        {
          severity: "warning",
          type: "style",
          message: "trim one descriptive phrase",
        },
      ],
    })
  })

  it("explains blocked status from persisted truth", () => {
    const schema = applyDeepSessionStatus(createEmptyStatusSchema(), {
      projectPath: "C:/test/project",
      conversationId: "conv-blocked",
      userRequest: "Generate chapter 3",
      chapterNumber: 3,
      draftStatus: DraftStatus.Ready,
      stage: "failed",
      sessionStatus: "blocked",
      checkpoint: {
        version: 1,
        originalRequest: "Generate chapter 3",
        taskId: "tsk-ch003-conv-blocked",
        chapterNumber: 3,
        stage: "after_review",
        taskBrief: "Repair the chronology issue.",
        draftContent: "Draft body for chapter 3.",
        currentContent: "Draft body for chapter 3.",
        gateSummary: createGateSummary(),
      },
    })

    const explanation = explainDeepSessionStatus(schema)

    expect(explanation.status).toBe("blocked")
    expect(explanation.activeStepIndex).toBe(3)
    expect(explanation.activeStepLabel).toBe("Review")
    expect(explanation.label).toBe("状态真源：blocked")
    expect(explanation.detail).toContain("流程停在 Review")
    expect(explanation.timeline[3]).toMatchObject({
      label: "Review",
      status: "blocked",
    })
  })

  it("keeps the latest completed step when the session is aborted", () => {
    const current = applyDeepSessionStatus(createEmptyStatusSchema(), {
      projectPath: "C:/test/project",
      conversationId: "conv-running",
      userRequest: "Generate chapter 3",
      chapterNumber: 3,
      draftStatus: DraftStatus.Ready,
      stage: "after_revision",
      sessionStatus: "running",
      checkpoint: {
        version: 1,
        originalRequest: "Generate chapter 3",
        taskId: "tsk-ch003-conv-running",
        chapterNumber: 3,
        stage: "after_revision",
        taskBrief: "Prepare the final hook.",
        draftContent: "Revision draft body.",
        currentContent: "Revision draft body.",
      },
    })

    const aborted = applyDeepSessionStatus(current, {
      projectPath: "C:/test/project",
      conversationId: "conv-running",
      userRequest: "Generate chapter 3",
      chapterNumber: 3,
      draftStatus: DraftStatus.Ready,
      stage: "aborted",
      sessionStatus: "paused",
      checkpoint: {
        version: 1,
        originalRequest: "Generate chapter 3",
        taskId: "tsk-ch003-conv-running",
        chapterNumber: 3,
        stage: "after_revision",
        taskBrief: "Prepare the final hook.",
        draftContent: "Revision draft body.",
        currentContent: "Revision draft body.",
      },
    })

    const explanation = explainDeepSessionStatus(aborted)

    expect(aborted.active_step_index).toBe(4)
    expect(aborted.status).toBe("paused")
    expect(explanation.label).toBe("状态真源：paused")
    expect(explanation.timeline[4]).toMatchObject({
      label: "Revision",
      status: "paused",
    })
  })

  it("requests a schema reset when a new conversation starts from after_context", () => {
    const current = applyDeepSessionStatus(createEmptyStatusSchema(), {
      projectPath: "C:/test/project",
      conversationId: "conv-old",
      userRequest: "Generate chapter 2",
      chapterNumber: 2,
      draftStatus: DraftStatus.Ready,
      stage: "after_review",
      sessionStatus: "running",
      checkpoint: {
        version: 1,
        originalRequest: "Generate chapter 2",
        taskId: "tsk-ch002-conv-old",
        chapterNumber: 2,
        stage: "after_review",
        taskBrief: "Keep the first branch aligned.",
        draftContent: "Old draft body.",
        currentContent: "Old draft body.",
      },
    })

    expect(shouldResetStatusSchema(current, {
      projectPath: "C:/test/project",
      conversationId: "conv-new",
      userRequest: "Generate chapter 3",
      chapterNumber: 3,
      draftStatus: DraftStatus.Pending,
      stage: "after_context",
      sessionStatus: "running",
    })).toBe(true)
  })
})
