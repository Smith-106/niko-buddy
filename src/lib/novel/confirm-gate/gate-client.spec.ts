import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import {
  classifyGate,
  confirmGate,
  fetchLoopState,
  isExpired,
  listPendingGates,
  rejectGate,
  remainingWindowMs,
  resolveGate,
  resumeAfterHalt,
  timeoutSeconds,
} from "./gate-client";
import type { PendingGate } from "./gate-classify";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function pending(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    request_id: "gate-1-0",
    op: "deleteFile",
    target: "book/chapter-1.md",
    class: "irreversible",
    hit_criteria: ["destructive_op"],
    actor: "agent",
    created_at_ms: 1_700_000_000_000,
    deadline_ms: 1_700_000_120_000,
    diff_summary: "deleteFile -> book/chapter-1.md (irreversible, criteria: destructive_op)",
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("gate-client / IPC 契约", () => {
  it("classifyGate 走 confirm_gate_classify 并默认 actor=agent", async () => {
    invokeMock.mockResolvedValue("require_confirm");
    const out = await classifyGate("deleteFile", "book/chapter-1.md");
    expect(out).toBe("require_confirm");
    expect(invokeMock).toHaveBeenCalledWith("confirm_gate_classify", {
      op: "deleteFile",
      target: "book/chapter-1.md",
      actor: "agent",
    });
  });

  it("classifyGate 可显式传 cli", async () => {
    invokeMock.mockResolvedValue("denied");
    await classifyGate("deleteFile", "QM/raw/notes.md", "cli");
    expect(invokeMock).toHaveBeenCalledWith("confirm_gate_classify", {
      op: "deleteFile",
      target: "QM/raw/notes.md",
      actor: "cli",
    });
  });

  it("listPendingGates 走 confirm_gate_pending", async () => {
    invokeMock.mockResolvedValue([pending()]);
    const list = await listPendingGates();
    expect(list).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("confirm_gate_pending");
  });

  it("resolveGate 透传 requestId / decision / note", async () => {
    invokeMock.mockResolvedValue({
      decision: "allowed",
      class: "irreversible",
      hit_criteria: ["destructive_op"],
      request_id: "gate-1-0",
      reason: "confirmed by human",
    });
    const out = await resolveGate("gate-1-0", "allowed", "reviewed");
    expect(out.decision).toBe("allowed");
    expect(invokeMock).toHaveBeenCalledWith("confirm_gate_resolve", {
      requestId: "gate-1-0",
      decision: "allowed",
      note: "reviewed",
    });
  });

  it("confirmGate / rejectGate / resumeAfterHalt 语义固定", async () => {
    invokeMock.mockResolvedValue({ decision: "allowed" });
    await confirmGate("gate-1-0");
    expect(invokeMock).toHaveBeenLastCalledWith("confirm_gate_resolve", {
      requestId: "gate-1-0",
      decision: "allowed",
      note: "",
    });

    await rejectGate("gate-1-0", "no");
    expect(invokeMock).toHaveBeenLastCalledWith("confirm_gate_resolve", {
      requestId: "gate-1-0",
      decision: "denied",
      note: "no",
    });

    await resumeAfterHalt("halt-1-0", "reviewed");
    expect(invokeMock).toHaveBeenLastCalledWith("confirm_gate_resolve", {
      requestId: "halt-1-0",
      decision: "resume_after_halt",
      note: "reviewed",
    });
  });

  it("fetchLoopState 走 confirm_gate_loop_state", async () => {
    invokeMock.mockResolvedValue({
      halted: true,
      fingerprint: "deleteFile|book/chapter-1.md",
      halt_request_id: "halt-1-0",
      count: 3,
      window_ms: 60_000,
      threshold: 3,
      since_ms: 1_700_000_000_000,
      reason: "repeated",
    });
    const st = await fetchLoopState();
    expect(st.halted).toBe(true);
    expect(st.threshold).toBe(3);
    expect(invokeMock).toHaveBeenCalledWith("confirm_gate_loop_state");
  });
});

describe("gate-client / 响应窗口", () => {
  it("剩余窗口随当前时间递减，过期即 0", () => {
    const p = pending();
    expect(remainingWindowMs(p, p.created_at_ms)).toBe(120_000);
    expect(remainingWindowMs(p, p.deadline_ms)).toBe(0);
    expect(remainingWindowMs(p, p.deadline_ms + 5_000)).toBe(0);
  });

  it("isExpired 与剩余窗口同源", () => {
    const p = pending();
    expect(isExpired(p, p.deadline_ms - 1)).toBe(false);
    expect(isExpired(p, p.deadline_ms)).toBe(true);
  });

  it("超时文案秒数与镜像常量一致", () => {
    expect(timeoutSeconds()).toBe(120);
  });
});
