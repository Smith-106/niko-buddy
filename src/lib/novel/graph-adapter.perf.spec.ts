import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * TASK-401 (PERF-03 / PAT-G2 graph-adapter): WIKILINK_RE 预编译缓存结构守卫。
 *
 * 背景: mergeExistingPage 原先每调用一次就 `new RegExp(WIKILINK_RE.source, "g")`
 * 重建两个等价正则 (re1/re2)。TASK-401 把两处提升为模块级预编译常量
 * WIKILINK_RE1 / WIKILINK_RE2 (模块加载时编译一次), 循环前 lastIndex = 0 复位,
 * 以保持带 /g exec 语义不变。
 *
 * 本 spec 是静态源断言 (readFileSync + 正则/括号扫描, 同
 * novel-session-status.twin-structural.spec.ts 风格, 无 ts-morph):
 * 一旦有人重新引入函数体内 new RegExp(WIKILINK_RE, 或常量被复制/改名,
 * 测试立即红。行为不变性由既有行为 spec (projection-status-ledger.spec.ts
 * 的 supersedeFact 用例) 与 tsc 覆盖, 本 spec 只守卫编译次数不变量。
 */
describe("TASK-401 / PERF-03: graph-adapter WIKILINK_RE 预编译缓存结构不变量", () => {
  const sourcePath = resolve(__dirname, "graph-adapter.ts")
  const source = readFileSync(sourcePath, "utf-8")

  function lineIndexOf(substr: string, fromIndex = 0): number {
    const idx = source.indexOf(substr, fromIndex)
    expect(idx, `substring ${substr} should exist in source`).toBeGreaterThanOrEqual(0)
    return source.slice(0, idx).split("\n").length
  }

  /** 提取 `function name(` 起始的函数体 (含签名, 括号配平到收尾 `}`)。 */
  function extractFunctionBody(name: string): string {
    const start = source.indexOf(`function ${name}(`)
    expect(start, `function ${name} should exist`).toBeGreaterThanOrEqual(0)
    const open = source.indexOf("{", start)
    expect(open).toBeGreaterThanOrEqual(0)
    let depth = 0
    for (let i = open; i < source.length; i++) {
      const ch = source[i]
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) return source.slice(start, i + 1)
      }
    }
    throw new Error(`unbalanced braces extracting ${name}`)
  }

  it("模块级常量 WIKILINK_RE1/WIKILINK_RE2 各定义恰好 1 次 (编译次数=1 可测)", () => {
    const re1Defs = source.match(/const\s+WIKILINK_RE1\s*=\s*new\s+RegExp\(WIKILINK_RE\.source,\s*["']g["']\)/g) ?? []
    const re2Defs = source.match(/const\s+WIKILINK_RE2\s*=\s*new\s+RegExp\(WIKILINK_RE\.source,\s*["']g["']\)/g) ?? []
    expect(re1Defs.length, "WIKILINK_RE1 应恰有 1 处模块级定义").toBe(1)
    expect(re2Defs.length, "WIKILINK_RE2 应恰有 1 处模块级定义").toBe(1)
    // 两处必须位于 mergeExistingPage 函数之前 (模块级, 非函数体内)。
    const fnLine = lineIndexOf("function mergeExistingPage(")
    const re1Line = lineIndexOf("const WIKILINK_RE1 =")
    const re2Line = lineIndexOf("const WIKILINK_RE2 =")
    expect(re1Line).toBeLessThan(fnLine)
    expect(re2Line).toBeLessThan(fnLine)
  })

  it("函数体内无 new RegExp(WIKILINK_RE (无逐调用重编译)", () => {
    const body = extractFunctionBody("mergeExistingPage")
    expect(body).not.toMatch(/new\s+RegExp\(\s*WIKILINK_RE/)
  })

  it("全文件 new RegExp(WIKILINK_RE 仅命中 2 处模块级定义 (编译次数=2)", () => {
    // 2 = WIKILINK_RE1 + WIKILINK_RE2。若有人重新引入函数体内 new RegExp,
    // 计数 > 2 直接红; 若常量被合并删除, 计数 < 2 也红。
    const matches = source.match(/new\s+RegExp\(\s*WIKILINK_RE/g) ?? []
    expect(matches.length, "应恰好 2 处 new RegExp(WIKILINK_RE (模块级 WIKILINK_RE1/RE2)").toBe(2)
  })

  it("每轮 exec 循环前 lastIndex = 0 复位 (>= 2 处)", () => {
    const resets = source.match(/lastIndex\s*=\s*0/g) ?? []
    expect(resets.length, "WIKILINK_RE1/RE2 循环前各需 1 处 lastIndex = 0").toBeGreaterThanOrEqual(2)
    const body = extractFunctionBody("mergeExistingPage")
    expect((body.match(/lastIndex\s*=\s*0/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // exec 循环引用的是模块级常量, 而非局部重建的 RegExp。
    expect(body).toMatch(/WIKILINK_RE1\.lastIndex\s*=\s*0/)
    expect(body).toMatch(/WIKILINK_RE2\.lastIndex\s*=\s*0/)
  })

  it("exec 调用点全部使用模块级常量 (re1/re2 局部重建已移除)", () => {
    const body = extractFunctionBody("mergeExistingPage")
    const execCalls = body.match(/\.exec\(/g) ?? []
    expect(execCalls.length, "mergeExistingPage 应恰有 2 处 exec (incoming + merged)").toBe(2)
    expect(body).toMatch(/WIKILINK_RE1\.exec\(incoming\)/)
    expect(body).toMatch(/WIKILINK_RE2\.exec\(merged\)/)
    expect(body).not.toMatch(/\bre1\b/)
    expect(body).not.toMatch(/\bre2\b/)
  })
})
