import { describe, expect, it } from "vitest"
import {
  acceptAllDeAiBatchDrafts,
  acceptDeAiBatchDraft,
  backoffDelayMs,
  createDeAiBatchState,
  createSemaphore,
  deAiBatchDraftPath,
  DE_AI_BATCH_SCHEMA,
  deriveRemainingQueue,
  discardDeAiBatch,
  isTransientLlmError,
  loadDeAiBatchDraft,
  loadDeAiBatchState,
  rejectDeAiBatchDraft,
  resumeDeAiBatchState,
  runBatch,
  runDeAiBatch,
  runWithBackoff,
  saveDeAiBatchDraft,
  saveDeAiBatchState,
} from "./index"

describe("de-ai-batch index — canonical 出口完整性", () => {
  it("导出全部公共 API（类型 + 常量 + 函数）", () => {
    expect(DE_AI_BATCH_SCHEMA).toBe("de-ai-batch/1.0")
    expect(typeof runDeAiBatch).toBe("function")
    expect(typeof acceptAllDeAiBatchDrafts).toBe("function")
    expect(typeof acceptDeAiBatchDraft).toBe("function")
    expect(typeof rejectDeAiBatchDraft).toBe("function")
    expect(typeof discardDeAiBatch).toBe("function")
    expect(typeof createSemaphore).toBe("function")
    expect(typeof runWithBackoff).toBe("function")
    expect(typeof runBatch).toBe("function")
    expect(typeof backoffDelayMs).toBe("function")
    expect(typeof isTransientLlmError).toBe("function")
    expect(typeof createDeAiBatchState).toBe("function")
    expect(typeof deriveRemainingQueue).toBe("function")
    expect(typeof resumeDeAiBatchState).toBe("function")
    expect(typeof loadDeAiBatchState).toBe("function")
    expect(typeof saveDeAiBatchState).toBe("function")
    expect(typeof deAiBatchDraftPath).toBe("function")
    expect(typeof saveDeAiBatchDraft).toBe("function")
    expect(typeof loadDeAiBatchDraft).toBe("function")
  })
})
