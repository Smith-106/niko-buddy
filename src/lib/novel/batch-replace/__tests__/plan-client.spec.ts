import { describe, expect, it } from "vitest";

import type { FileDiffModel } from "../diff-model";
import {
  BATCH_REPLACE_OP,
  buildEdgesFromPlan,
  isGateDenied,
  isGateRequireConfirm,
  isPlanBlockedByCanonGate,
  isTransactionRolledBack,
  preflightCanonEdgeGate,
} from "../plan-client";

const plan: FileDiffModel[] = [
  { path: "book/c1.md", replacements: 2, changes: [{ line: 1, before: "林舟", after: "林舟舟" }] },
  { path: "book/c2.md", replacements: 0, changes: [] },
];

describe("批量替换计划客户端", () => {
  it("操作名与 Rust 侧的破坏性操作名一致", () => {
    expect(BATCH_REPLACE_OP).toBe("batchReplace");
  });

  it("只为有命中的文件生成待写入边", () => {
    const edges = buildEdgesFromPlan(plan, { find: "林舟", replace: "林舟舟" });
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe("林舟");
    expect(edges[0].targetId).toBe("林舟舟");
    expect(edges[0].predicate).toBe("replaced_by");
  });

  it("空 find 不产出任何边", () => {
    expect(buildEdgesFromPlan(plan, { find: "", replace: "x" })).toEqual([]);
  });

  it("写前门无冲突时不阻断提交", () => {
    const result = preflightCanonEdgeGate(plan, { find: "林舟", replace: "林舟舟" }, []);
    expect(isPlanBlockedByCanonGate(result)).toBe(false);
    expect(result.state).not.toBe("BLOCK");
  });

  it("同一实体已经换过另一个名字时，写前门在阻断模式下拦下整个计划", () => {
    const existing = [
      {
        id: "edge-1",
        sourceId: "林舟",
        targetId: "林舟帆",
        predicate: "replaced_by",
        digest: "other-name",
        validAt: null,
        invalidAt: null,
      },
    ];
    const warnOnly = preflightCanonEdgeGate(plan, { find: "林舟", replace: "林舟舟" }, existing, {
      mode: "warn",
    });
    expect(warnOnly.state).toBe("WARN");
    expect(isPlanBlockedByCanonGate(warnOnly)).toBe(false);
    expect(warnOnly.conflicts[0].reason.startsWith("BLOCK")).toBe(true);

    const blocking = preflightCanonEdgeGate(plan, { find: "林舟", replace: "林舟舟" }, existing, {
      mode: "block",
    });
    expect(blocking.state).toBe("BLOCK");
    expect(isPlanBlockedByCanonGate(blocking)).toBe(true);
  });

  it("确认门与回滚前缀可识别，普通错误不误判", () => {
    expect(
      isGateRequireConfirm(new Error("GATE_REQUIRE_CONFIRM:abc:target is irreversible")),
    ).toBe(true);
    expect(isGateDenied(new Error("GATE_DENIED: protected"))).toBe(true);
    expect(isTransactionRolledBack(new Error("BATCH_REPLACE_ROLLED_BACK: commit failed"))).toBe(
      true,
    );
    expect(isGateRequireConfirm(new Error("BATCH_REPLACE_IO: read failed"))).toBe(false);
    expect(isGateDenied(new Error("BATCH_REPLACE_IO: read failed"))).toBe(false);
  });
});
