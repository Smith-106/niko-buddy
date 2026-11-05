/**
 * gate-classify.statements.spec.ts — 覆盖率战役增量（statements/branches 尾段）。
 *
 * 只补既有 gate-classify.spec.ts 未触达的行为面，不重复漂移探测：
 *   - hitCriteria 的 protected_prefix / rebuildable 两条判据（此前只测到
 *     destructive_op 与 external_side_effect）
 *   - hitCriteria 非破坏性操作的隐式 else（无判据命中）
 *   - parseGateError 的四条缺省形态：无分隔符 / 空前缀 / 空 request_id 段 / 拒绝类无分隔符
 *
 * @license MIT © Niko Buddy
 */

import { describe, expect, it } from "vitest";

import {
  GATE_CONFIRM_PREFIX,
  GATE_DENIED_PREFIX,
  hitCriteria,
  parseGateError,
} from "./gate-classify";

describe("gate-classify / hitCriteria 判据补齐", () => {
  it("受保护区目标命中 protected_prefix（与破坏性判据叠加，保序）", () => {
    expect(hitCriteria("deleteFile", "QM/raw/notes.md", "agent")).toEqual([
      "protected_prefix",
      "destructive_op",
    ]);
    expect(hitCriteria("batchReplace", ".novel/schema.md", "user")).toEqual([
      "protected_prefix",
      "destructive_op",
    ]);
  });

  it("快照产物与派生目录命中 rebuildable", () => {
    // deleteFile 本身是破坏性操作 → 判据按 op → protected → rebuildable 顺序累加
    expect(hitCriteria("deleteFile", ".novel/snapshots/ch1/body.md", "agent")).toEqual([
      "destructive_op",
      "rebuildable",
    ]);
    expect(hitCriteria("deleteFolder", "backups/auto/x", "agent")).toEqual([
      "destructive_op",
      "rebuildable",
    ]);
  });

  it("非破坏性操作指向不可重建目标 → 无判据（不进裁决面）", () => {
    expect(hitCriteria("writeFile", "book/chapter-1.md", "agent")).toEqual([]);
  });
});

describe("gate-classify / parseGateError 缺省形态", () => {
  it("确认类错误无分隔符 → requestId 取整段 rest，reason 为空串", () => {
    expect(parseGateError(`${GATE_CONFIRM_PREFIX}gate-1-0`)).toEqual({
      code: "require_confirm",
      requestId: "gate-1-0",
      reason: "",
    });
  });

  it("确认类错误空前缀 rest → requestId 回退 null（不伪造 id）", () => {
    expect(parseGateError(GATE_CONFIRM_PREFIX)).toEqual({
      code: "require_confirm",
      requestId: null,
      reason: "",
    });
  });

  it("确认类错误空 request_id 段 → requestId null，reason 保真", () => {
    expect(parseGateError(`${GATE_CONFIRM_PREFIX}:target is irreversible`)).toEqual({
      code: "require_confirm",
      requestId: null,
      reason: "target is irreversible",
    });
  });

  it("拒绝类错误无分隔符 → reason 取整段 rest", () => {
    expect(parseGateError(`${GATE_DENIED_PREFIX}protected truth surface`)).toEqual({
      code: "denied",
      requestId: null,
      reason: "protected truth surface",
    });
  });
});
