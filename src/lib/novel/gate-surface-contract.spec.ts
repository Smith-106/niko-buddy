/**
 * gate-surface-contract.spec.ts — Rust 门枚举 ↔ TS 字面量镜像对账（W2-4 四-3）。
 *
 * `src-tauri/src/agent_gate.rs` 的 `RebuildClass/GateActor/Decision` 以 snake_case
 * 序列化过桥；前端 `gate-classify.ts` 的联合类型必须与之一字不差，否则直传即落
 * 脏数据。本文件从 Rust 源码提取 `as_str` 字面量，与 TS 运行时元组双向对账：
 * Rust 加变体而 TS 未跟进（或反之）都会在这里变红。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  GATE_ACTORS,
  GATE_DECISIONS,
  REBUILD_CLASSES,
} from "./confirm-gate/gate-classify"

const ROOT = resolve(__dirname, "..", "..", "..")
const GATE_RS = join(ROOT, "src-tauri", "src", "agent_gate.rs")

/** 提取 `EnumName::Variant => "literal"` 的字面量集合。 */
function rustLiterals(source: string, enumName: string): Set<string> {
  const found = new Set<string>()
  const re = new RegExp(`${enumName}::(\\w+)\\s*=>\\s*"([^"]+)"`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) found.add(m[2])
  return found
}

describe("gate surface contract — Rust ↔ TS 字面量镜像", () => {
  const source = readFileSync(GATE_RS, "utf8")

  it.each([
    ["RebuildClass", REBUILD_CLASSES],
    ["GateActor", GATE_ACTORS],
    ["Decision", GATE_DECISIONS],
  ] as Array<[string, readonly string[]]>)("%s 双向一致", (enumName, tsValues) => {
    const rust = rustLiterals(source, enumName)
    expect(rust.size).toBeGreaterThan(0)
    expect(new Set(tsValues)).toEqual(rust)
  })
})
