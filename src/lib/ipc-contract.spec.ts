/**
 * ipc-contract.spec.ts — ISO 3.3.2 Interoperability 契约测试。
 *
 * Tauri IPC 直 invoke 契约：所有参数 key 必须是 camelCase（Rust 侧 serde
 * rename_all="camelCase"），snake_case 参数名会导致反序列化失败。
 *
 * 扫 src/ 所有 invoke("cmd", { ... }) 字面量调用点，断言参数对象 key 无下划线。
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const SRC = resolve(__dirname, "..")

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".spec.ts") && !entry.endsWith(".spec.tsx")) yield p
  }
}

// invoke("cmd", { key: value, ... }) 参数对象 key 提取
// 只查顶层参数 key（camelCase 契约）；嵌套对象/数组元素按 Rust struct 字段名
// （如 ExpectedChunkInput{chunk_index}）允许 snake_case——Rust Deserialize 无
// rename_all 时字段名即协议名。
const INVOKE_RE = /invoke(?:<[^>]+>)?\(\s*"([a-zA-Z_]+)"\s*,\s*\{([^}]*)\}/g
const TOP_KEY_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g

describe("IPC camelCase contract (ISO 3.3.2 interoperability)", () => {
  it("所有 invoke 顶层参数 key 都是 camelCase（无 snake_case）", () => {
    const violations: string[] = []
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf-8")
      let m: RegExpExecArray | null
      INVOKE_RE.lastIndex = 0
      while ((m = INVOKE_RE.exec(src)) !== null) {
        const [full, cmd, argsBody] = m
        // 只取顶层 key——截断在第一个嵌套 { 或 [ 之前的 key 列表
        const topLevel = argsBody.split(/[{\[]/, 1)[0]
        let km: RegExpExecArray | null
        TOP_KEY_RE.lastIndex = 0
        while ((km = TOP_KEY_RE.exec(topLevel)) !== null) {
          const key = km[1]
          if (key.includes("_")) {
            const line = src.slice(0, m.index).split("\n").length
            violations.push(`${file.replace(SRC, "src")}:${line} invoke("${cmd}") 顶层参数 "${key}" 含下划线（snake_case）`)
          }
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([])
  })

  it("所有 IPC 命令名都是 snake_case（Rust command 命名约定）", () => {
    // Tauri command 命名约定：snake_case。参数顶层 key 才是 camelCase。
    const seen = new Set<string>()
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf-8")
      let m: RegExpExecArray | null
      INVOKE_RE.lastIndex = 0
      while ((m = INVOKE_RE.exec(src)) !== null) seen.add(m[1])
    }
    const bad = [...seen].filter((c) => /[A-Z]/.test(c))
    expect(bad, `IPC 命令名应 snake_case 非 camelCase: ${bad.join(", ")}`).toEqual([])
    // 命令名清单快照（>60 个已验证 snake_case）
    expect(seen.size).toBeGreaterThan(50)
  })
})
