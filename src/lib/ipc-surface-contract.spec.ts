/**
 * ipc-surface-contract.spec.ts — IPC 注册面 ↔ 调用面双向对账（B5）。
 *
 * 背景：`src-tauri/src/lib.rs` 的 `generate_handler![...]` 是 webview 的**注册面**，
 * 前端 `invoke("...")` 是**调用面**。两者任意单向漂移都是缺陷：
 *   - 注册但从未调用 = 纯攻击面 / 断链（secret_* 与 vector_run_startup_reconcile
 *     就曾长期零调用——B3/B4 的修复对象）；
 *   - 调用但未注册 = 死调用（运行时才炸，静态无门）。
 *
 * 断言：
 *   1. 调用面 ⊆ 注册面（任何 invoke 目标都已在 generate_handler 注册）；
 *   2. 注册面 ⊆ 调用面 ∪ 白名单（UNWIRED_COMMANDS，每项一行理由）；
 *   3. 白名单卫生：条目必须已注册、必须仍未接线、理由非空（接线后必须移除）；
 *   4. 动态 invoke 站点受控：静态解析不出字面量命令名的调用点必须显式登记。
 *
 * 扫描范围：**生产代码**（src/**，排除 `*.spec.*` / `*.test.*` / `*.bench.*`）。
 * 测试与基准文件运行在 mock 的 invoke 上，不是真实调用面——例如
 * `src/test-helpers/memory.bench.ts` 的 `get_process_memory` 只是 mock 桩
 * （该命令在 Rust 侧根本不存在），把它算进调用面只会制造假缺陷。
 */

import * as ts from "typescript"
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const ROOT = resolve(__dirname, "..", "..")
const LIB_RS = join(ROOT, "src-tauri", "src", "lib.rs")
const SRC = join(ROOT, "src")

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 未接线注册命令白名单（`注册面 ⊆ 调用面 ∪ 白名单` 的「白名单」一侧）。
 * 每项必须：在 generate_handler 注册面内、不在前端调用面内、附一行理由。
 * **一旦接线，必须从本表移除**（由白名单卫生断言强制）。
 */
const UNWIRED_COMMANDS: ReadonlyArray<{ command: string; reason: string }> = [
  {
    command: "secret_get",
    // 刻意不接线：唯一 secret 值出口（Rust 侧 `secret_store.rs::secret_get`）只允许
    // 传输层（sync_target.rs 推送/拉取时 `read_secret_sync`）即时消费；前端一旦有
    // 读取面，明文凭据就会流经 webview。保持零调用是安全不变量（C-011），不是断链。
    // 该命令仍被纵切面契约（vertical-slice-contract.spec.ts）要求存在于 Rust 侧。
    reason:
      "唯一 secret 值出口，只允许 Rust 传输层即时消费；前端零调用是安全不变量（C-011），刻意保留注册",
  },
]

/**
 * 动态 invoke 站点登记：命令名经变量/映射传入，静态扫描无法解析出字面量。
 * 新增此类站点必须登记并给理由（否则对账出现盲区）。
 *
 * B2 注：canon-graph-client 的 invokeCanon 安全壳**不在此登记**——对账器已将其
 * 调用点 `invokeCanon<...>(` 视为 invoke 别名（字面量逐条计入 wired），变量 command
 * 透传经“中转透传去重”排除，无盲区（见 extractInvokeSites 注释）。
 */
const DYNAMIC_INVOKE_SITES: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "src/lib/local-cli-config.ts",
    reason:
      "命令名由 detectCommand() 的联合类型变量传入（claude/codex/cursor/antigravity detect 四字面量均已注册且各有静态调用面），无法在调用点静态提取",
  },
  {
    file: "src/components/settings/sections/cli-probe-strip.tsx",
    reason:
      "PROBES 表驱动并行 invoke（command 经 p.command 变量传入；四字面量 clamp 在 PROBES 常量表，四命令均已注册且 llm-provider-widgets 各有静态调用面），无法在调用点静态提取",
  },
  {
    file: "src/commands/fs.ts",
    reason:
      "S3 fileLockGuard choke point：withFileLockRetry 包裹 invokeFs，命令名字面量仍静态可审，属受控集中出口",
  },
]

// ── 注册面：解析 lib.rs 的 generate_handler![...] ────────────────────────────

function extractRegisteredCommands(): string[] {
  const text = readFileSync(LIB_RS, "utf-8")
  const block = text.match(/generate_handler!\[([\s\S]*?)\]/)
  if (!block) throw new Error(`generate_handler! not found in ${LIB_RS}`)
  // 先剥行注释（注释里可能出现逗号/括号），再按逗号切分条目。
  const body = block[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
  const names: string[] = []
  for (const token of body.split(",")) {
    const trimmed = token.trim()
    if (trimmed.length === 0) continue
    const last = trimmed.split("::").pop()?.trim() ?? ""
    if (IDENT_RE.test(last)) names.push(last)
  }
  return names
}

// ── 调用面：解析前端 invoke("cmd", ...) ─────────────────────────────────────

/** 只扫生产代码；测试/基准文件运行在 mock invoke 上，不属于真实调用面。
 * 注：安全壳中转（如 canon-graph-client invokeCanon 的变量 command 透传）不视为
 * 动态盲区——字面量均在同文件调用点逐条写出，由首实参扫描正常计入 wired；
 * 真正的动态站点（变量来自跨函数联合类型）才进 unresolved 登记。 */
function* walkProductionFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const path = join(dir, entry)
    const st = statSync(path)
    if (st.isDirectory()) yield* walkProductionFiles(path)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(spec|test|bench)\./.test(entry)) yield path
  }
}

interface InvokeScan {
  /** 命令名 → 首个调用点（相对路径:行号）。 */
  called: Map<string, string>
  /** 静态解析不出字面量命令名的站点（相对路径:行号）。 */
  unresolved: string[]
}

/**
 * 四-10：invoke( / invokeCanon<...>( 调用点提取改走 TS compiler API。
 * 旧 INVOKE_RE＋括号步进扫描在换行/嵌套/注释下漏误报；AST 天然跳过注释与
 * 类型实参，首实参按表达式语义取值：
 * - 字符串字面量（含无替换模板）→ 直接计入；
 * - 条件表达式 → 两分支字面量都计入（覆盖 `cond ? "a" : "b"` 动态选择）；
 * - 括号/`as`/`satisfies`/`!` 包装 → 拆包后递归判定；
 * - 其余（变量/模板插值/函数调用）→ unresolved 盲区上报。
 * B2 注：安全壳调用点 `invokeCanon<...>(` 视为 invoke 调用面的别名（同文件字面量逐条
 * 计入 wired），其泛型实参是类型节点，不在 arguments 内，不会污染。
 */
function firstArgLiterals(expr: ts.Expression, source: ts.SourceFile): string[] | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text]
  if (ts.isParenthesizedExpression(expr)) return firstArgLiterals(expr.expression, source)
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) {
    return firstArgLiterals(expr.expression, source)
  }
  if (ts.isConditionalExpression(expr)) {
    const whenTrue = firstArgLiterals(expr.whenTrue, source)
    const whenFalse = firstArgLiterals(expr.whenFalse, source)
    if (whenTrue && whenFalse) return [...whenTrue, ...whenFalse]
    return null
  }
  return null
}

function extractInvokeSites(): InvokeScan {
  const called = new Map<string, string>()
  const unresolved: string[] = []
  for (const file of walkProductionFiles(SRC)) {
    const text = readFileSync(file, "utf-8")
    const rel = relative(ROOT, file).replace(/\\/g, "/")
    const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        // fs.ts 的 invokeFs("cmd", ...) 是 S3 fileLockGuard 集中出口，命令名为字面量，视为 invoke 别名（仅限该文件）。
        const isFsAlias = rel === "src/commands/fs.ts" && ts.isIdentifier(callee) && callee.text === "invokeFs"
        if (ts.isIdentifier(callee) && (callee.text === "invoke" || callee.text === "invokeCanon" || isFsAlias)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          const first = node.arguments[0]
          const literals = first ? firstArgLiterals(first, source) : null
          if (literals && literals.length > 0) {
            for (const command of literals) {
              if (!called.has(command)) called.set(command, `${rel}:${line}`)
            }
          } else {
            // 中转透传定义点（`invoke<T>(command, ...)`）无字面量是预期的，不计盲区。
            if (rel === "src/lib/novel/canon-graph-client.ts" && callee.text === "invoke" && first && first.getText(source) === "command") {
              // 透传，不计
            } else {
              unresolved.push(`${rel}:${line}`)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { called, unresolved }
}

const registered = extractRegisteredCommands()
const registeredSet = new Set(registered)
const { called, unresolved } = extractInvokeSites()

describe("IPC 注册面 ↔ 调用面双向对账（B5）", () => {
  it("注册面 sanity：generate_handler 提取 ≥100 条命令且无重复注册", () => {
    expect(registered.length).toBeGreaterThanOrEqual(100)
    const duplicates = registered.filter((cmd, index) => registered.indexOf(cmd) !== index)
    expect([...new Set(duplicates)], `重复注册: ${[...new Set(duplicates)].join(", ")}`).toEqual([])
  })

  it("调用面 ⊆ 注册面：任何 invoke 的目标都已在 generate_handler 注册", () => {
    const dangling = [...called.keys()].filter((cmd) => !registeredSet.has(cmd))
    const detail = dangling.map((cmd) => `${cmd} (${called.get(cmd)})`)
    expect(detail, `invoke 指向未注册命令（运行时必炸）: ${detail.join("; ")}`).toEqual([])
  })

  it("注册面 ⊆ 调用面 ∪ 白名单：未接线的注册命令必须逐条登记并给理由", () => {
    const wired = new Set(called.keys())
    const whitelisted = new Set(UNWIRED_COMMANDS.map((entry) => entry.command))
    const unaccounted = registered.filter((cmd) => !wired.has(cmd) && !whitelisted.has(cmd))
    expect(
      [...new Set(unaccounted)],
      `注册了但既无前端调用、也不在白名单（纯攻击面/断链）: ${[...new Set(unaccounted)].join(", ")}`,
    ).toEqual([])
  })

  it("白名单卫生：条目已注册、确实未接线、理由非空（接线后必须移除）", () => {
    const wired = new Set(called.keys())
    const problems: string[] = []
    for (const entry of UNWIRED_COMMANDS) {
      if (!registeredSet.has(entry.command)) {
        problems.push(`${entry.command}: 不在注册面（拼写错误或命令已删除）`)
      }
      if (wired.has(entry.command)) {
        problems.push(`${entry.command}: 已被前端接线，必须从白名单移除`)
      }
      if (entry.reason.trim().length === 0) {
        problems.push(`${entry.command}: 缺一行理由`)
      }
    }
    expect(problems, problems.join("; ")).toEqual([])
  })

  it("动态 invoke 站点受控：静态解析不出的站点必须显式登记（防对账盲区）", () => {
    const unresolvedFiles = [
      ...new Set(unresolved.map((site) => site.split(":").slice(0, -1).join(":"))),
    ].sort()
    const knownFiles = DYNAMIC_INVOKE_SITES.map((entry) => entry.file).sort()
    expect(
      unresolvedFiles,
      `动态 invoke 站点与登记不一致（新增需登记 / 移除需清理）: ${unresolvedFiles.join(", ")}`,
    ).toEqual(knownFiles)
    for (const entry of DYNAMIC_INVOKE_SITES) {
      expect(entry.reason.trim().length, `${entry.file} 缺一行理由`).toBeGreaterThan(0)
      expect(existsSync(join(ROOT, entry.file)), `${entry.file} 不存在`).toBe(true)
    }
  })
})
