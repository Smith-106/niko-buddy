#!/usr/bin/env node
/**
 * check-consistency.mjs — 前后端一致性的机械门禁
 *
 * 覆盖三层一致性（真源 = 代码，不依赖注释与文档声明）：
 *
 *   内容一致性  IPC 参数名 ⊆ Rust 签名（含必填形参漏传拦截）；i18n zh/en 键集等价；版本单一真源
 *   架构一致性  invoke ↔ `#[tauri::command]` ↔ `generate_handler!` 三方闭合；
 *               capabilities 覆盖所用插件；生成物 atlas 内部自洽
 *   功能一致性  事件 topic 有 Rust 发射方；视图 union ↔ 渲染/计划态闭合
 *
 * 纪律：只读源码 + 只读生成物；确定性输出（路径排序）；无网络；无副作用。
 * 失败即以非 0 退出并逐条列出反例，禁止 warn-only 通过。
 *
 * 用法：node scripts/check-consistency.mjs [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SRC = join(ROOT, "src")
const RUST = join(ROOT, "src-tauri", "src")

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "target" || entry === "dist") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, filter, out)
    else if (filter(entry)) out.push(full)
  }
  return out
}

const rel = (p) => relative(ROOT, p).split("\\").join("/")
export const isSpec = (p) => /\.spec\.[cm]?[jt]sx?$/.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p)
export const isTestOrHelper = (p) => {
  const normalized = String(p).split("\\").join("/")
  return (
    isSpec(normalized) ||
    /\.bench\.[cm]?[jt]sx?$/.test(normalized) ||
    /(?:^|\/)(?:test-helpers|__tests__)\//.test(normalized)
  )
}
const norm = (name) => name.replace(/[_-]/g, "").toLowerCase()

const INJECTED_TYPES = [/AppHandle/, /State\s*</, /^Window/, /^Webview/, /CommandScope/, /Manager\s*</]

// ── 词法辅助（Rust / JS-TS 注释剥离与括号配平）────────────────────────────

/**
 * 字符级剥离 Rust 行注释与嵌套块注释，
 * 保留普通字符串、原始字符串 `r#"..."#` 与字符字面量 `'x'`（不把生命周期 `'a` 误判为字符串）。
 */
export function stripRustComments(source) {
  let out = ""
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    // 原始字符串 r"..." / r#"..."# / br#"..."#
    if (
      (ch === "r" || (ch === "b" && next === "r")) &&
      (i === 0 || !/[A-Za-z0-9_]/.test(source[i - 1]))
    ) {
      let j = ch === "b" ? i + 2 : i + 1
      let hashes = 0
      while (j < source.length && source[j] === "#") {
        hashes += 1
        j += 1
      }
      if (source[j] === '"') {
        const closing = `"${"#".repeat(hashes)}`
        const end = source.indexOf(closing, j + 1)
        if (end === -1) {
          out += source.slice(i)
          break
        }
        out += source.slice(i, end + closing.length)
        i = end + closing.length
        continue
      }
    }
    if (ch === '"') {
      out += ch
      i += 1
      while (i < source.length) {
        const c = source[i]
        out += c
        if (c === "\\" && i + 1 < source.length) {
          out += source[i + 1]
          i += 2
          continue
        }
        i += 1
        if (c === '"') break
      }
      continue
    }
    if (ch === "'") {
      const charLit = source.slice(i).match(/^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n\r])'/)
      if (charLit) {
        out += charLit[0]
        i += charLit[0].length
        continue
      }
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2)
      if (end === -1) break
      out += "\n"
      i = end + 1
      continue
    }
    if (ch === "/" && next === "*") {
      let depth = 1
      i += 2
      out += " "
      while (i < source.length && depth > 0) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth += 1
          i += 2
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth -= 1
          i += 2
        } else {
          if (source[i] === "\n") out += "\n"
          i += 1
        }
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const REGEX_PREV_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "typeof",
  "void",
  "in",
  "of",
  "new",
  "delete",
  "await",
  "yield",
  "else",
  "do",
])

function canStartRegex(prevChar, prevWord) {
  if (!prevChar) return true
  if ("([,{;:!=&|?+-*%^~".includes(prevChar)) return true
  if (prevWord && REGEX_PREV_KEYWORDS.has(prevWord)) return true
  return false
}

function skipRegexLiteral(source, start) {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const ch = source[i]
    if (ch === "\n" || ch === "\r") return -1
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "[") {
      inClass = true
      i += 1
      continue
    }
    if (ch === "]") {
      inClass = false
      i += 1
      continue
    }
    if (ch === "/" && !inClass) {
      i += 1
      while (i < source.length && /[a-z]/i.test(source[i])) i += 1
      return i
    }
    i += 1
  }
  return -1
}

/**
 * 去掉 JS/TS 注释。必须字符级走一遍并跟踪引号/模板/正则状态：
 * - `"foo // bar"` 里的 `//` 不是注释；
 * - 单/双引号在未转义换行处复位，防止 TSX 文本中的英文撇号（如 `It's`）吞噬后续代码；
 * - 模板字符串支持 `${...}` 嵌套表达式内的注释剥离。
 */
export function stripComments(source) {
  let out = ""
  let i = 0
  let prevChar = ""
  let prevWord = ""
  const templateBraceStack = []

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      const slice = end === -1 ? source.slice(i + 2) : source.slice(i + 2, end)
      out += slice.includes("\n") ? slice.replace(/[^\n]/g, "") : " "
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2)
      if (end === -1) break
      out += "\n"
      i = end + 1
      continue
    }
    if (ch === "/" && next !== "/" && next !== "*" && canStartRegex(prevChar, prevWord)) {
      const end = skipRegexLiteral(source, i)
      if (end > 0) {
        out += source.slice(i, end)
        prevChar = "/"
        prevWord = ""
        i = end
        continue
      }
    }
    if (ch === '"' || ch === "'") {
      const q = ch
      out += ch
      i += 1
      while (i < source.length) {
        const c = source[i]
        out += c
        if (c === "\\" && i + 1 < source.length) {
          out += source[i + 1]
          i += 2
          continue
        }
        i += 1
        if (c === q || c === "\n") break
      }
      prevChar = q
      prevWord = ""
      continue
    }
    if (ch === "`") {
      out += ch
      i += 1
      while (i < source.length) {
        const c = source[i]
        if (c === "\\" && i + 1 < source.length) {
          out += c + source[i + 1]
          i += 2
          continue
        }
        if (c === "$" && source[i + 1] === "{") {
          out += "${"
          i += 2
          templateBraceStack.push(0)
          prevChar = "{"
          prevWord = ""
          break
        }
        out += c
        i += 1
        if (c === "`") {
          prevChar = "`"
          prevWord = ""
          break
        }
      }
      continue
    }
    if (templateBraceStack.length > 0) {
      if (ch === "{") {
        templateBraceStack[templateBraceStack.length - 1] += 1
      } else if (ch === "}") {
        if (templateBraceStack[templateBraceStack.length - 1] === 0) {
          templateBraceStack.pop()
          out += ch
          i += 1
          // 回到外层模板字符串正文
          while (i < source.length) {
            const c = source[i]
            if (c === "\\" && i + 1 < source.length) {
              out += c + source[i + 1]
              i += 2
              continue
            }
            if (c === "$" && source[i + 1] === "{") {
              out += "${"
              i += 2
              templateBraceStack.push(0)
              prevChar = "{"
              prevWord = ""
              break
            }
            out += c
            i += 1
            if (c === "`") {
              prevChar = "`"
              prevWord = ""
              break
            }
          }
          continue
        }
        templateBraceStack[templateBraceStack.length - 1] -= 1
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1
      const word = source.slice(i, end)
      out += word
      prevWord = word
      prevChar = word[word.length - 1]
      i = end
      continue
    }
    out += ch
    if (!/\s/.test(ch)) {
      prevChar = ch
      prevWord = ""
    }
    i += 1
  }
  return out
}

function skipWsAndComments(source, index) {
  let i = index
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i += 1
      continue
    }
    if (source[i] === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    break
  }
  return i
}

/** 跳过字符串字面量，返回闭合引号后的下标。 */
function skipQuotedString(source, start) {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === "\\" && i + 1 < source.length) {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    if ((quote === "'" || quote === '"') && ch === "\n") return i + 1
    i += 1
  }
  return source.length
}

/** 跳过模板字面量（支持 `${...}` 嵌套），返回闭合反引号后的下标。 */
function skipTemplateLiteral(source, start) {
  let i = start + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === "\\" && i + 1 < source.length) {
      i += 2
      continue
    }
    if (ch === "`") return i + 1
    if (ch === "$" && source[i + 1] === "{") {
      const close = findMatchingClose(source, i + 1, "{", "}")
      if (close < 0) return source.length
      i = close + 1
      continue
    }
    i += 1
  }
  return source.length
}

/**
 * 字符级尖括号配平：跨越任意嵌套泛型（如 `Record<string, Array<Foo>>`、
 * `Map<string, (x: number) => Promise<void>>`），跳过 `=>` 箭头与注释/字符串。
 * 返回闭合 `>` 之后的下标；若无法配平则返回 -1。
 */
function skipBalancedAngleBrackets(source, openIndex) {
  if (source[openIndex] !== "<") return -1
  let depth = 1
  let braceDepth = 0
  let i = openIndex + 1
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipQuotedString(source, i)
      continue
    }
    if (ch === "`") {
      i = skipTemplateLiteral(source, i)
      continue
    }
    // 函数类型箭头 `=>` 中的 `>` 不是泛型闭合
    if (ch === "=" && next === ">") {
      i += 2
      continue
    }
    if (ch === "{") {
      braceDepth += 1
      i += 1
      continue
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1)
      i += 1
      continue
    }
    if (ch === ";" && braceDepth === 0) return -1
    if (ch === "<") {
      depth += 1
      i += 1
      continue
    }
    if (ch === ">") {
      depth -= 1
      if (depth === 0) return i + 1
      i += 1
      continue
    }
    i += 1
  }
  return -1
}

/** 查找与 `openIndex` 处开括号配对的闭括号下标（跳过注释、字符串、模板与正则）。 */
function findMatchingClose(source, openIndex, openCh, closeCh) {
  if (source[openIndex] !== openCh) return -1
  let depth = 0
  let i = openIndex
  let prevChar = ""
  let prevWord = ""
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "/" && next !== "/" && next !== "*" && canStartRegex(prevChar, prevWord)) {
      const end = skipRegexLiteral(source, i)
      if (end > 0) {
        prevChar = "/"
        prevWord = ""
        i = end
        continue
      }
    }
    if (ch === '"' || ch === "'") {
      i = skipQuotedString(source, i)
      prevChar = ch
      prevWord = ""
      continue
    }
    if (ch === "`") {
      i = skipTemplateLiteral(source, i)
      prevChar = "`"
      prevWord = ""
      continue
    }
    if (ch === openCh) {
      depth += 1
      prevChar = ch
      prevWord = ""
      i += 1
      continue
    }
    if (ch === closeCh) {
      depth -= 1
      if (depth === 0) return i
      prevChar = ch
      prevWord = ""
      i += 1
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1
      prevWord = source.slice(i, end)
      prevChar = prevWord[prevWord.length - 1]
      i = end
      continue
    }
    if (!/\s/.test(ch)) {
      prevChar = ch
      prevWord = ""
    }
    i += 1
  }
  return -1
}

/** 按顶层逗号切分表达式/对象体（跳过注释、字符串、模板、正则与嵌套 `()[]{}`）。 */
function splitTopLevelCommas(body) {
  const parts = []
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  let start = 0
  let i = 0
  let prevChar = ""
  let prevWord = ""
  while (i < body.length) {
    const ch = body[i]
    const next = body[i + 1]
    if (ch === "/" && next === "/") {
      const end = body.indexOf("\n", i + 2)
      i = end === -1 ? body.length : end + 1
      continue
    }
    if (ch === "/" && next === "*") {
      const end = body.indexOf("*/", i + 2)
      i = end === -1 ? body.length : end + 2
      continue
    }
    if (ch === "/" && next !== "/" && next !== "*" && canStartRegex(prevChar, prevWord)) {
      const end = skipRegexLiteral(body, i)
      if (end > 0) {
        prevChar = "/"
        prevWord = ""
        i = end
        continue
      }
    }
    if (ch === '"' || ch === "'") {
      i = skipQuotedString(body, i)
      prevChar = ch
      prevWord = ""
      continue
    }
    if (ch === "`") {
      i = skipTemplateLiteral(body, i)
      prevChar = "`"
      prevWord = ""
      continue
    }
    if (ch === "(") depthParen += 1
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1)
    else if (ch === "[") depthBracket += 1
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1)
    else if (ch === "{") depthBrace += 1
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1)
    else if (ch === "," && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
      prevChar = ","
      prevWord = ""
      i += 1
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < body.length && /[A-Za-z0-9_$]/.test(body[end])) end += 1
      prevWord = body.slice(i, end)
      prevChar = prevWord[prevWord.length - 1]
      i = end
      continue
    }
    if (!/\s/.test(ch)) {
      prevChar = ch
      prevWord = ""
    }
    i += 1
  }
  parts.push(body.slice(start))
  return parts
}

/** 剥离表达式最外层配平圆括号。 */
function unwrapOuterParens(expr) {
  let cur = expr.trim()
  while (cur.startsWith("(") && cur.endsWith(")")) {
    const close = findMatchingClose(cur, 0, "(", ")")
    if (close === cur.length - 1) {
      cur = cur.slice(1, -1).trim()
    } else {
      break
    }
  }
  return cur
}

/** 解析三元表达式顶层 `?` 与配对 `:` 的位置；非三元返回 null。 */
function splitTopLevelConditional(expr) {
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  let qPos = -1
  let nestedTernary = 0
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    const next = expr[i + 1]
    if (ch === '"' || ch === "'") {
      i = skipQuotedString(expr, i)
      continue
    }
    if (ch === "`") {
      i = skipTemplateLiteral(expr, i)
      continue
    }
    if (ch === "(") depthParen += 1
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1)
    else if (ch === "[") depthBracket += 1
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1)
    else if (ch === "{") depthBrace += 1
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1)
    else if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      // 跳过可选链 `?.` 与空值合并 `??`
      if (ch === "?" && next !== "." && next !== "?" && expr[i - 1] !== "?") {
        if (qPos === -1) qPos = i
        else nestedTernary += 1
      } else if (ch === ":" && qPos !== -1) {
        if (nestedTernary === 0) {
          return {
            whenTrue: expr.slice(qPos + 1, i).trim(),
            whenFalse: expr.slice(i + 1).trim(),
          }
        }
        nestedTernary -= 1
      }
    }
    i += 1
  }
  return null
}

/**
 * 从第 1 实参提取静态命令名字面量：
 * - 直接字符串字面量（含无插值模板）→ `[name]`；
 * - 若 `allowConditional` 为真，支持条件表达式 `cond ? "cmd_a" : "cmd_b"` 两分支；
 * - 其余（变量/定义形参/动态拼接）→ `[]`。
 */
function extractCommandLiterals(rawExpr, { allowConditional = true } = {}) {
  const clean = stripComments(rawExpr).trim()
  if (!clean) return []
  const unwrapped = allowConditional ? unwrapOuterParens(clean) : clean
  const literal = unwrapped.match(/^(["'`])([A-Za-z0-9_]+)\1$/)
  if (literal) return [literal[2]]
  if (!allowConditional) return []
  const cond = splitTopLevelConditional(unwrapped)
  if (!cond) return []
  const left = extractCommandLiterals(cond.whenTrue, { allowConditional: true })
  const right = extractCommandLiterals(cond.whenFalse, { allowConditional: true })
  if (left.length === 0 || right.length === 0) return []
  return [...left, ...right]
}

function aliasesForFile(fileRel) {
  const normalized = String(fileRel).split("\\").join("/")
  if (normalized === "src/commands/fs.ts") return ["invokeFs"]
  if (normalized === "src/lib/novel/canon-graph-client.ts") return ["invokeCanon"]
  return []
}

// ── 源码解析（可导入纯函数）────────────────────────────────────────────────

/** 解析单个 Rust 文件中的所有 `#[tauri::command]` 签名。 */
export function parseCommandSignaturesFromSource(code, fileRel = "<memory>") {
  const commands = new Map()
  for (const attr of code.matchAll(/#\[tauri::command[^\]]*\]/g)) {
    const rest = code.slice(attr.index + attr[0].length)
    const fn = rest.match(/^((?:\s*(?:\/\/[^\n]*|\/\/![^\n]*|#\[[^\]]*\])\r?\n|\s)*)\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/)
    if (!fn) continue
    const open = fn[0].length - 1 + fn.index
    let depth = 0
    let close = -1
    for (let i = open; i < rest.length; i += 1) {
      const ch = rest[i]
      if (ch === "(") depth += 1
      else if (ch === ")") {
        depth -= 1
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close < 0) continue
    const raw = rest.slice(open + 1, close)
    const parts = []
    let d = 0
    let cur = ""
    for (const ch of raw) {
      if ("([{<".includes(ch)) d += 1
      if (")]}".includes(ch) || ch === ">") d -= 1
      if (ch === "," && d === 0) {
        parts.push(cur)
        cur = ""
      } else {
        cur += ch
      }
    }
    parts.push(cur)
    const params = []
    const requiredParams = []
    for (const part of parts) {
      const t = part.trim()
      const m = t.match(/^(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/)
      if (!m) continue
      const type = m[2].trim()
      if (INJECTED_TYPES.some((re) => re.test(type))) continue
      params.push(m[1])
      // Tauri deserializes omitted Option arguments as None.
      if (!/^(?:(?:::)?(?:std|core)::option::)?Option\s*</.test(type)) requiredParams.push(m[1])
    }
    commands.set(fn[2], { params, requiredParams, file: fileRel })
  }
  return commands
}

function parseCommandSignatures(rustFiles) {
  const commands = new Map()
  for (const file of rustFiles) {
    const code = readFileSync(file, "utf8")
    for (const [name, sig] of parseCommandSignaturesFromSource(code, rel(file))) {
      commands.set(name, sig)
    }
  }
  return commands
}

/** 从 `lib.rs` 源码提取 `generate_handler![...]` 注册命令名（先剥离行/块注释）。 */
export function parseHandlerRegistrationsFromSource(libSource) {
  const stripped = stripRustComments(libSource)
  const block = stripped.match(/generate_handler!\s*\[([\s\S]*?)\]/)
  if (!block) return null
  return block[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop().trim())
    .filter(Boolean)
}

function parseHandlerRegistrations() {
  const lib = readFileSync(join(RUST, "lib.rs"), "utf8")
  return parseHandlerRegistrationsFromSource(lib)
}

/**
 * 字符级解析单个 TS/TSX 文件中的所有 IPC 调用点：
 * - 跳过注释、字符串/模板字面量、正则字面量；
 * - 识别 `invoke` 以及受控文件白名单别名（`src/commands/fs.ts` 的 `invokeFs`、
 *   `src/lib/novel/canon-graph-client.ts` 的 `invokeCanon`）；
 * - 支持任意嵌套泛型参数（含 `=>` 箭头函数类型）；
 * - 精确标注第 2 实参形态：`argsKind: "none" | "object" | "dynamic"`。
 */
export function parseTsInvocationsFromSource(code, fileRel = "<memory>", options = {}) {
  const allowedCallees = new Set(["invoke", ...(options.aliases ?? aliasesForFile(fileRel))])
  const sites = []
  let i = 0
  let prevChar = ""
  let prevWord = ""
  const templateBraceStack = []

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i + 2)
      i = end === -1 ? code.length : end + 1
      continue
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2)
      i = end === -1 ? code.length : end + 2
      continue
    }
    if (ch === "/" && next !== "/" && next !== "*" && canStartRegex(prevChar, prevWord)) {
      const end = skipRegexLiteral(code, i)
      if (end > 0) {
        prevChar = "/"
        prevWord = ""
        i = end
        continue
      }
    }
    if (ch === '"' || ch === "'") {
      i = skipQuotedString(code, i)
      prevChar = ch
      prevWord = ""
      continue
    }
    if (ch === "`") {
      i += 1
      while (i < code.length) {
        const c = code[i]
        if (c === "\\" && i + 1 < code.length) {
          i += 2
          continue
        }
        if (c === "$" && code[i + 1] === "{") {
          i += 2
          templateBraceStack.push(0)
          prevChar = "{"
          prevWord = ""
          break
        }
        i += 1
        if (c === "`") {
          prevChar = "`"
          prevWord = ""
          break
        }
      }
      continue
    }
    if (templateBraceStack.length > 0) {
      if (ch === "{") {
        templateBraceStack[templateBraceStack.length - 1] += 1
      } else if (ch === "}") {
        if (templateBraceStack[templateBraceStack.length - 1] === 0) {
          templateBraceStack.pop()
          i += 1
          while (i < code.length) {
            const c = code[i]
            if (c === "\\" && i + 1 < code.length) {
              i += 2
              continue
            }
            if (c === "$" && code[i + 1] === "{") {
              i += 2
              templateBraceStack.push(0)
              prevChar = "{"
              prevWord = ""
              break
            }
            i += 1
            if (c === "`") {
              prevChar = "`"
              prevWord = ""
              break
            }
          }
          continue
        }
        templateBraceStack[templateBraceStack.length - 1] -= 1
      }
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < code.length && /[A-Za-z0-9_$]/.test(code[end])) end += 1
      const ident = code.slice(i, end)

      if (allowedCallees.has(ident) && prevChar !== "." && prevWord !== "function") {
        let pos = skipWsAndComments(code, end)
        let ok = true
        if (code[pos] === "<") {
          const afterGeneric = skipBalancedAngleBrackets(code, pos)
          if (afterGeneric < 0) ok = false
          else pos = skipWsAndComments(code, afterGeneric)
        }
        if (ok && code[pos] === "(") {
          const closeParen = findMatchingClose(code, pos, "(", ")")
          if (closeParen > pos) {
            const argList = code.slice(pos + 1, closeParen)
            const rawArgs = splitTopLevelCommas(argList)
            const arg0 = rawArgs[0] ?? ""
            const isAlias = ident !== "invoke"
            // invokeFs / invokeCanon 强制要求首个非空白字符为引号字面量，跳过 wrapper 定义与动态透传
            const cmdNames = extractCommandLiterals(arg0, { allowConditional: !isAlias })
            if (cmdNames.length > 0) {
              const rawArg1 = rawArgs[1] === undefined ? "" : stripComments(rawArgs[1]).trim()
              let argsKind = "none"
              let keys = []
              let spread = false
              if (rawArg1 && rawArg1 !== "undefined") {
                if (rawArg1.startsWith("{") && findMatchingClose(rawArg1, 0, "{", "}") === rawArg1.length - 1) {
                  argsKind = "object"
                  const objBody = rawArg1.slice(1, -1)
                  for (const chunk of splitTopLevelCommas(objBody)) {
                    const t = stripComments(chunk).trim()
                    if (!t) continue
                    if (t.startsWith("...")) {
                      spread = true
                      continue
                    }
                    if (t.startsWith("[")) {
                      spread = true
                      continue
                    }
                    const named = t.match(/^(?:(["'])([A-Za-z0-9_$-]+)\1|([A-Za-z_$][A-Za-z0-9_$]*))\s*:/)
                    if (named) {
                      keys.push(named[2] ?? named[3])
                      continue
                    }
                    const shorthand = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/)
                    if (shorthand) keys.push(shorthand[1])
                  }
                } else {
                  argsKind = "dynamic"
                }
              }
              for (const name of cmdNames) {
                sites.push({ name, keys: [...keys], spread, argsKind, file: fileRel })
              }
            }
          }
        }
      }

      prevWord = ident
      prevChar = ident[ident.length - 1]
      i = end
      continue
    }

    if (!/\s/.test(ch)) {
      prevChar = ch
      prevWord = ""
    }
    i += 1
  }

  return sites
}

function parseTsInvocations(tsFiles) {
  const sites = []
  for (const file of tsFiles) {
    const fileRel = rel(file)
    const code = readFileSync(file, "utf8")
    sites.push(...parseTsInvocationsFromSource(code, fileRel))
  }
  return sites
}

/**
 * 校验 IPC 实参名与必填形参完整性（纯函数）：
 * - `argsKind === "dynamic"`：动态实参对象，豁免静态键校验；
 * - `argsKind === "none"`：若 Rust 命令存在非 Option 必填形参，直接报错拦截；
 * - `argsKind === "object"`：始终校验显式键名是否属于 Rust 形参；无 spread 时校验全部必填形参。
 */
export function validateIpcParams(sites, commands) {
  const problems = []
  for (const site of sites) {
    const command = commands.get(site.name)
    if (!command) continue
    if (site.argsKind === "dynamic") continue

    const rustNorm = new Set(command.params.map(norm))
    const extra = site.keys.filter((key) => !rustNorm.has(norm(key)))
    const missing =
      site.argsKind === "none"
        ? command.requiredParams
        : site.spread
          ? []
          : command.requiredParams.filter((p) => !site.keys.some((k) => norm(k) === norm(p)))

    if (extra.length > 0) {
      problems.push(`${site.name} ← ${site.file}: 多余实参 ${extra.join(",")}（Rust 形参: ${command.params.join(",") || "无"}）`)
    }
    if (missing.length > 0) {
      problems.push(`${site.name} ← ${site.file}: 缺实参 ${missing.join(",")}`)
    }
  }
  return problems
}

// ── 事件 topic ─────────────────────────────────────────────────────────────

const topicSignature = (pattern) => pattern.replace(/\$\{[^}]*\}/g, "\u0000").replace(/\{[^}]*\}/g, "\u0000")

function collectRustTopics(rustFiles) {
  const signatures = new Set()
  for (const file of rustFiles) {
    const code = readFileSync(file, "utf8")
    for (const m of code.matchAll(/\.emit(?:_to|_filter)?(?:\s*::<[^>]*>)?\s*\(\s*"([^"\n]+)"/g)) {
      signatures.add(topicSignature(m[1]))
    }
    for (const m of code.matchAll(/format!\(\s*"([^"]+)"/g)) signatures.add(topicSignature(m[1]))
    for (const m of code.matchAll(/const\s+[A-Z0-9_]*EVENT[A-Z0-9_]*\s*:\s*&str\s*=\s*"([^"]+)"/g)) {
      signatures.add(topicSignature(m[1]))
    }
  }
  return signatures
}

/** 从 `{ file, code }` 列表收集生产代码监听的事件 topic（自动跳过 `.spec.` / `.test.` / `.bench.` / `test-helpers`）。 */
export function collectTsListenTopicsFromEntries(entries) {
  const topics = new Map()
  for (const { file, code } of entries) {
    if (isTestOrHelper(file)) continue
    const clean = stripComments(code)
    for (const m of clean.matchAll(/\blisten(?:<[^>]*>)?\(\s*(["'`])((?:(?!\1)[\s\S])*)\1/g)) {
      const topic = m[2]
      if (/^(?:plugin:|tauri:)/.test(topic)) continue
      if (topic.includes("${")) {
        topics.set(topicSignature(topic), { raw: topic, file, dynamic: true })
        continue
      }
      if (!/^[A-Za-z][\w:./-]*$/.test(topic)) continue
      topics.set(topicSignature(topic), { raw: topic, file, dynamic: false })
    }
  }
  return topics
}

function collectTsListenTopics(tsFiles) {
  const entries = []
  for (const file of tsFiles) {
    const fileRel = rel(file)
    if (isTestOrHelper(fileRel)) continue
    entries.push({ file: fileRel, code: readFileSync(file, "utf8") })
  }
  return collectTsListenTopicsFromEntries(entries)
}

// ── i18n 键集等价 ──────────────────────────────────────────────────────────

function flatten(node, prefix = "", out = []) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out)
    else out.push(path)
  }
  return out
}

// ── 视图 union ↔ 渲染/计划态 ───────────────────────────────────────────────

/** 取从 openIndex 的 `{` 起、括号配平的代码块（跳过字符串，避免花括号误判）。 */
function balancedBlock(source, openIndex) {
  if (source[openIndex] !== "{") return null
  const close = findMatchingClose(source, openIndex, "{", "}")
  return close < 0 ? null : source.slice(openIndex, close + 1)
}

/**
 * 占位页是否真的**位于**守卫块内部。
 *
 * 只比较「守卫出现在 <PlannedView 之前」会被 `if (false && guard) {}` 加后面
 * 无条件渲染的死代码骗过；这里按括号配平取守卫控制的块，要求渲染落在块里。
 */
function rendersInsideGuard(source, guardPattern, bracePosition) {
  const re = new RegExp(guardPattern, "g")
  let match
  while ((match = re.exec(source)) !== null) {
    const open = bracePosition === "after"
      ? source.indexOf("{", match.index + match[0].length - 1)
      : source.lastIndexOf("{", match.index)
    if (open === -1) continue
    const block = balancedBlock(source, open)
    if (block && /<PlannedView[\s/>]/.test(block)) return true
  }
  return false
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)) {
  const jsonOut = argv.includes("--json")
  const failures = []
  const results = []

  const record = (name, ok, detail) => {
    results.push({ name, ok, detail })
    if (!ok) failures.push({ name, detail })
  }

  const tsFiles = walk(SRC, (n) => /\.(ts|tsx|mts)$/.test(n))
  const rustFiles = walk(RUST, (n) => n.endsWith(".rs"))
  const commands = parseCommandSignatures(rustFiles)
  const productionInvocations = parseTsInvocations(tsFiles).filter((site) => !isTestOrHelper(site.file))

  function checkIpcRegistry() {
    const handler = parseHandlerRegistrations()
    if (handler === null) {
      record("ipc/generate_handler", false, ["lib.rs 未找到 generate_handler! 清单"])
      return
    }
    const handlerSet = new Set(handler)
    const commandSet = new Set(commands.keys())

    const missingInRust = [...handler].filter((name) => !commandSet.has(name))
    record(
      "ipc/handler-declares-command",
      missingInRust.length === 0,
      missingInRust.length === 0
        ? [`${handler.length} 条注册命令均有 #[tauri::command] 定义`]
        : missingInRust.map((name) => `generate_handler! 注册但无 #[tauri::command] 定义: ${name}`),
    )

    const unregistered = [...commandSet].filter((name) => !handlerSet.has(name))
    record(
      "ipc/command-is-registered",
      unregistered.length === 0,
      unregistered.length === 0
        ? [`${commandSet.size} 个命令全部进入 invoke_handler`]
        : unregistered.map((name) => `已定义但未注册（前端 invoke 必然失败）: ${name} ← ${commands.get(name).file}`),
    )

    const unknown = [
      ...new Set(productionInvocations.filter((s) => !commandSet.has(s.name)).map((s) => `${s.name} ← ${s.file}`)),
    ]
    record(
      "ipc/invoke-has-command",
      unknown.length === 0,
      unknown.length === 0
        ? [`${productionInvocations.length} 处 invoke 全部命中 Rust 命令`]
        : unknown.map((u) => `invoke 无对应 Rust 命令: ${u}`),
    )
  }

  function checkIpcParams() {
    const problems = validateIpcParams(productionInvocations, commands)
    record(
      "ipc/param-names",
      problems.length === 0,
      problems.length === 0
        ? [`${productionInvocations.length} 处 invoke 实参名与 Rust 形参一致`]
        : problems,
    )
  }

  function checkEvents() {
    const rustTopics = collectRustTopics(rustFiles)
    const tsTopics = collectTsListenTopics(tsFiles)
    const orphans = []
    for (const [signature, info] of tsTopics) {
      if (rustTopics.has(signature)) continue
      orphans.push(`${info.raw} ← ${info.file}（Rust 侧无同名/同形发射点）`)
    }
    record(
      "events/listen-has-emitter",
      orphans.length === 0,
      orphans.length === 0 ? [`${tsTopics.size} 个前端监听 topic 均有 Rust 发射方`] : orphans,
    )
  }

  function checkI18n() {
    const zh = JSON.parse(readFileSync(join(SRC, "i18n/zh.json"), "utf8"))
    const en = JSON.parse(readFileSync(join(SRC, "i18n/en.json"), "utf8"))
    const zhKeys = new Set(flatten(zh))
    const enKeys = new Set(flatten(en))
    const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
    const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))
    const details = []
    if (onlyZh.length > 0) details.push(`仅 zh 有: ${onlyZh.slice(0, 20).join(", ")}${onlyZh.length > 20 ? ` …(+${onlyZh.length - 20})` : ""}`)
    if (onlyEn.length > 0) details.push(`仅 en 有: ${onlyEn.slice(0, 20).join(", ")}${onlyEn.length > 20 ? ` …(+${onlyEn.length - 20})` : ""}`)
    record(
      "i18n/key-parity",
      details.length === 0,
      details.length === 0 ? [`zh/en 各 ${zhKeys.size} 键，键集完全一致`] : details,
    )
  }

  function checkViews() {
    const store = readFileSync(join(SRC, "stores/wiki-store.ts"), "utf8")
    const unionSource = store.match(/activeView:\s*([^\n]+)/)
    if (!unionSource) {
      record("views/union", false, ["wiki-store.ts 未找到 activeView 联合类型"])
      return
    }
    const union = [...new Set(unionSource[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1)))]
    const contentArea = stripComments(readFileSync(join(SRC, "components/layout/content-area.tsx"), "utf8"))
    // 引号风格不构成豁免：单引号 case 躲过门禁就等于门禁在说谎
    const cases = new Set(
      [...contentArea.matchAll(/case\s+["']([^"']+)["']/g)].map((m) => m[1]),
    )
    const conditions = new Set(
      [...contentArea.matchAll(/activeView\s*===?\s*["']([^"']+)["']/g)].map((m) => m[1]),
    )
    const plannedRegistry = readFileSync(join(SRC, "components/layout/planned-views.ts"), "utf8")
    const planned = new Set(
      [...plannedRegistry.matchAll(/\{\s*view:\s*["']([^"']+)["']/g)].map((m) => m[1]),
    )
    const plannedGuards = new Set(
      [...contentArea.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[^;\n]*isPlannedView\(\s*activeView\s*\)/g)].map((m) => m[1]),
    )
    const hasPlannedIfGuard = /if\s*\(\s*isPlannedView\(\s*activeView\s*\)\s*\)/.test(contentArea)
    const plannedRendered =
      [...plannedGuards].some(
        (name) =>
          rendersInsideGuard(contentArea, `\\{\\s*${name}\\s*(?:\\?|&&)`, "before") ||
          rendersInsideGuard(contentArea, `if\\s*\\(\\s*${name}\\s*\\)`, "after"),
      ) ||
      (hasPlannedIfGuard &&
        rendersInsideGuard(contentArea, `if\\s*\\(\\s*isPlannedView\\(\\s*activeView\\s*\\)\\s*\\)`, "after"))
    const nav = readFileSync(join(SRC, "components/layout/nav-items.ts"), "utf8")
    const navViews = new Set([...nav.matchAll(/view:\s*["']([^"']+)["']/g)].map((m) => m[1]))

    const dead = union.filter(
      (v) =>
        !cases.has(v) &&
        !conditions.has(v) &&
        !(planned.has(v) && plannedRendered),
    )
    record(
      "views/union-is-renderable",
      dead.length === 0,
      dead.length === 0
        ? [
            `${union.length} 个视图 = ${cases.size} 渲染 + ${conditions.size} 条件 + ${planned.size} 计划态占位` +
              (planned.size > 0 ? (plannedRendered ? "（占位页已接线）" : "（占位页未接线）") : ""),
          ]
        : dead.map((v) =>
            planned.has(v)
              ? `activeView 计划态成员已登记但 content-area 未接占位渲染（会落到 default）: ${v}`
              : `activeView 成员既无渲染分支也非计划态（点开落到 default）: ${v}`,
          ),
    )

    const strayPlanned = [...planned].filter((v) => !union.includes(v))
    record(
      "views/planned-in-union",
      strayPlanned.length === 0,
      strayPlanned.length === 0
        ? [`${planned.size} 个计划态视图均在 activeView union 内`]
        : strayPlanned.map((v) => `planned-views 登记了 union 外的视图: ${v}`),
    )

    const shadowedPlanned = [...planned].filter((v) => cases.has(v) || conditions.has(v))
    record(
      "views/planned-not-shadowed",
      shadowedPlanned.length === 0,
      shadowedPlanned.length === 0
        ? ["计划态登记表未与真实渲染分支重叠"]
        : shadowedPlanned.map((v) => `planned-views 登记了已实现的视图（登记表说谎）: ${v}`),
    )

    const strayCases = [...cases].filter((v) => !union.includes(v))
    record(
      "views/case-in-union",
      strayCases.length === 0,
      strayCases.length === 0 ? ["content-area 全部 case 均在 activeView union 内"] : strayCases.map((v) => `case "${v}" 不在 activeView union`),
    )

    const strayNav = [...navViews].filter((v) => !union.includes(v))
    record(
      "views/nav-in-union",
      strayNav.length === 0,
      strayNav.length === 0 ? [`${navViews.size} 个导航项均在 union 内`] : strayNav.map((v) => `导航项 view "${v}" 不在 activeView union`),
    )
  }

  function checkVersion() {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
    const tauri = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).version
    const cargo = readFileSync(join(ROOT, "src-tauri/Cargo.toml"), "utf8").match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
    const changelogTs = readFileSync(join(SRC, "lib/changelog.ts"), "utf8").match(/version:\s*"([^"]+)"/)?.[1]
    const changelogMd = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").match(/^##\s*\[([^\]]+)\]/m)?.[1]
    const sources = { "package.json": pkg, "tauri.conf.json": tauri, "Cargo.toml": cargo, "changelog.ts": changelogTs, "CHANGELOG.md": changelogMd }
    const distinct = [...new Set(Object.values(sources).filter(Boolean))]
    const details = Object.entries(sources).map(([file, version]) => `${file}=${version ?? "缺失"}`)
    const ok = distinct.length === 1 && Object.values(sources).every(Boolean)
    record("version/single-source", ok, ok ? [`全部版本源一致: ${pkg}`] : [`版本源不一致: ${details.join(" / ")}`])
  }

  function checkCapabilities() {
    const capabilities = JSON.parse(readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"))
    const declared = capabilities.permissions.map((p) => (typeof p === "string" ? p : p.identifier))
    const usedPlugins = new Set()
    for (const file of tsFiles) {
      if (isTestOrHelper(rel(file))) continue
      const code = readFileSync(file, "utf8")
      for (const m of code.matchAll(/["']@tauri-apps\/plugin-([a-z-]+)["']/g)) usedPlugins.add(m[1])
    }
    const missing = [...usedPlugins].filter(
      (plugin) => !declared.some((perm) => perm === `${plugin}:default` || perm.startsWith(`${plugin}:`)),
    )
    record(
      "caps/plugin-permission",
      missing.length === 0,
      missing.length === 0
        ? [`${usedPlugins.size} 个前端插件权限均在 capabilities 内`]
        : missing.map((p) => `使用了 @tauri-apps/plugin-${p} 但 capabilities/default.json 未授权 ${p}:*`),
    )
  }

  function checkAtlas() {
    const path = join(SRC, "lib/novel/module-atlas.generated.json")
    const atlas = JSON.parse(readFileSync(path, "utf8"))
    const modules = atlas.modules ?? []
    const stats = atlas.stats ?? {}
    const derived = {
      modules: modules.length,
      reachable: modules.filter((m) => m.r).length,
      unwired: modules.filter((m) => !m.r).length,
      orphan: modules.filter((m) => m.o).length,
      specOnly: modules.filter((m) => m.x).length,
      barrelOnly: modules.filter((m) => m.b).length,
      edges: modules.reduce((sum, m) => sum + (m.i?.length ?? 0), 0),
    }
    const drift = Object.entries(derived).filter(([key, value]) => stats[key] !== value)
    const indexProblems = []
    modules.forEach((m, index) => {
      for (const out of m.i ?? []) {
        if (out < 0 || out >= modules.length) indexProblems.push(`${m.p} 出边越界: ${out}（当前 ${index}）`)
      }
    })
    const details = [
      ...drift.map(([key, value]) => `stats.${key}=${stats[key]} 与实测 ${value} 不符`),
      ...indexProblems.slice(0, 10),
    ]
    record(
      "atlas/internal-consistency",
      details.length === 0,
      details.length === 0
        ? [`atlas ${stats.modules} 模块 / ${stats.edges} 边，统计与索引自洽`]
        : details,
    )
  }

  const checks = [
    checkIpcRegistry,
    checkIpcParams,
    checkEvents,
    checkI18n,
    checkViews,
    checkVersion,
    checkCapabilities,
    checkAtlas,
  ]

  for (const check of checks) {
    try {
      check()
    } catch (error) {
      record(check.name, false, [`检查抛错: ${error instanceof Error ? error.message : String(error)}`])
    }
  }

  if (jsonOut) {
    process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, results }, null, 2)}\n`)
  } else {
    for (const { name, ok, detail } of results) {
      process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`)
      for (const line of detail) process.stdout.write(`     ${line}\n`)
    }
    const passed = results.filter((r) => r.ok).length
    process.stdout.write(`\n[check-consistency] RESULT: ${passed}/${results.length} passed\n`)
  }

  return failures.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main())
}
