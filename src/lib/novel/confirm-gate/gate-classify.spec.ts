import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DESTRUCTIVE_OPS,
  DERIVED_ROOTS,
  GATE_CONFIRM_PREFIX,
  GATE_DENIED_PREFIX,
  GATE_TIMEOUT_MS,
  LOOP_THRESHOLD,
  LOOP_WINDOW_MS,
  PROTECTED_PREFIXES,
  classifyRebuildClass,
  effectiveDecision,
  hitCriteria,
  isDestructiveOp,
  isProtectedTarget,
  normalizeGateTarget,
  parseGateError,
} from "./gate-classify";

const RUST_SOURCE = fileURLToPath(
  new URL("../../../../src-tauri/src/agent_gate.rs", import.meta.url),
);

describe("gate-classify / 漂移探测（真源 = agent_gate.rs）", () => {
  const rust = readFileSync(RUST_SOURCE, "utf8");

  it("超时与循环常量与 Rust 侧一致", () => {
    expect(rust).toContain(`pub const GATE_TIMEOUT_MS: u64 = ${GATE_TIMEOUT_MS.toLocaleString("en-US").replace(/,/g, "_")};`);
    expect(rust).toContain(`pub const LOOP_WINDOW_MS: u64 = ${LOOP_WINDOW_MS.toLocaleString("en-US").replace(/,/g, "_")};`);
    expect(rust).toContain(`pub const LOOP_THRESHOLD: u32 = ${LOOP_THRESHOLD};`);
  });

  it("受保护区清单与 Rust 侧一致", () => {
    for (const p of PROTECTED_PREFIXES) {
      expect(rust).toContain(`"${p}"`);
    }
    expect(PROTECTED_PREFIXES).toHaveLength(4);
  });

  it("破坏性操作清单与 Rust 侧一致", () => {
    for (const op of DESTRUCTIVE_OPS) {
      expect(rust).toContain(`"${op}"`);
    }
    expect(DESTRUCTIVE_OPS).toHaveLength(4);
  });

  it("可重建根只含既有目录约定", () => {
    for (const r of DERIVED_ROOTS) {
      expect(rust).toContain(`"${r}"`);
    }
    expect(rust).not.toContain('"output/"');
  });

  it("错误码前缀与 Rust 侧一致", () => {
    expect(rust).toContain(`"${GATE_CONFIRM_PREFIX}"`);
    expect(rust).toContain(`"${GATE_DENIED_PREFIX}"`);
  });
});

describe("gate-classify / 目标归一", () => {
  it("反斜杠与重复分隔符被折叠", () => {
    expect(normalizeGateTarget("QM\\\\raw//notes.md")).toBe("QM/raw/notes.md");
    expect(normalizeGateTarget("./QM/raw/notes.md")).toBe("QM/raw/notes.md");
  });

  it("不改变普通相对路径", () => {
    expect(normalizeGateTarget("book/chapter-1.md")).toBe("book/chapter-1.md");
  });
});

describe("gate-classify / 受保护区判定", () => {
  it("前缀命中", () => {
    expect(isProtectedTarget(".novel/status.json")).toBe(true);
    expect(isProtectedTarget(".novel/schema.md")).toBe(true);
    expect(isProtectedTarget("QM/raw/notes.md")).toBe(true);
    expect(isProtectedTarget("canon/entities.json")).toBe(true);
  });

  it("绝对路径不得绕过", () => {
    expect(isProtectedTarget("C:/proj/QM/raw/notes.md")).toBe(true);
    expect(isProtectedTarget("/home/u/proj/.novel/status.json")).toBe(true);
  });

  it("反斜杠与重复分隔符不得绕过", () => {
    expect(isProtectedTarget("QM\\\\raw/notes.md")).toBe(true);
    expect(isProtectedTarget("QM//raw//notes.md")).toBe(true);
  });

  it("普通路径与审计目录不算受保护", () => {
    expect(isProtectedTarget("book/chapter-1.md")).toBe(false);
    expect(isProtectedTarget(".novel/snapshots/ch1/body.md")).toBe(false);
    expect(isProtectedTarget(".novel/audit/gate-audit.jsonl")).toBe(false);
  });
});

describe("gate-classify / 三分类", () => {
  it("快照产物可重建", () => {
    expect(classifyRebuildClass(".novel/snapshots/ch1/body.md")).toBe("rebuildable");
  });

  it("既有投影目录为派生可重建", () => {
    expect(classifyRebuildClass(".qmai/lancedb")).toBe("derived_rebuildable");
    expect(classifyRebuildClass("backups/auto/x.zip")).toBe("derived_rebuildable");
  });

  it("受保护区与未知路径都判不可重建（保守方向）", () => {
    expect(classifyRebuildClass("QM/raw/notes.md")).toBe("irreversible");
    expect(classifyRebuildClass("book/chapter-1.md")).toBe("irreversible");
  });
});

describe("gate-classify / 四判据与裁决", () => {
  it("受保护区 + 破坏性操作 = 硬拒绝，CLI 也不能绕过", () => {
    const cls = classifyRebuildClass("QM/raw/notes.md");
    for (const actor of ["agent", "cli", "user", "external"] as const) {
      expect(effectiveDecision("deleteFile", "QM/raw/notes.md", cls, actor).decision).toBe("denied");
    }
  });

  it("外部进程指向非保护区不拦普通使用", () => {
    const cls = classifyRebuildClass("book/chapter-1.md");
    const out = effectiveDecision("runCommand", "book/chapter-1.md", cls, "cli");
    expect(out.decision).toBe("allowed");
    expect(hitCriteria("runCommand", "book/chapter-1.md", "cli")).toContain("external_side_effect");
  });

  it("可重建产物直接放行", () => {
    const cls = classifyRebuildClass(".novel/snapshots/ch1/body.md");
    expect(effectiveDecision("deleteFile", ".novel/snapshots/ch1/body.md", cls, "agent").decision).toBe(
      "allowed",
    );
  });

  it("不可重建目标要求确认", () => {
    const cls = classifyRebuildClass("book/chapter-1.md");
    expect(effectiveDecision("deleteFile", "book/chapter-1.md", cls, "agent").decision).toBe(
      "require_confirm",
    );
    expect(hitCriteria("deleteFile", "book/chapter-1.md", "agent")).toEqual([
      "destructive_op",
    ]);
  });

  it("非破坏性操作不进裁决面", () => {
    const cls = classifyRebuildClass("book/chapter-1.md");
    expect(effectiveDecision("writeFile", "book/chapter-1.md", cls, "agent").decision).toBe("allowed");
  });

  it("破坏性操作清单判定不区分大小写", () => {
    expect(isDestructiveOp("deleteFile")).toBe(true);
    expect(isDestructiveOp("DELETEFILE")).toBe(true);
    expect(isDestructiveOp("writeFile")).toBe(false);
  });
});

describe("gate-classify / 错误串解析", () => {
  it("确认类错误带回 request_id", () => {
    const parsed = parseGateError(`${GATE_CONFIRM_PREFIX}gate-1-0:target is irreversible`);
    expect(parsed).toEqual({
      code: "require_confirm",
      requestId: "gate-1-0",
      reason: "target is irreversible",
    });
  });

  it("拒绝类错误无 request_id", () => {
    const parsed = parseGateError(`${GATE_DENIED_PREFIX}denied:protected truth surface`);
    expect(parsed).toEqual({
      code: "denied",
      requestId: null,
      reason: "protected truth surface",
    });
  });

  it("非门错误返回 null", () => {
    expect(parseGateError("Failed to delete file 'x': not found")).toBeNull();
  });
});
