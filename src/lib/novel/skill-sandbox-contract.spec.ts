/**
 * Q20-skill-bundle 契约守卫：SKILL.md 的 `allowed-tools` 不得被当作授权。
 *
 * 背景（recon 结论，2026-10-26）：QMAI 的技能是**纯 Markdown 提示词注入**，没有代码
 * 执行通道——加载点读 `SKILL.md` 文本，执行点把文本拼进 prompt，技能本身不产生 IO。
 * 但 `skills/de-ai-writing/SKILL.md` 的 frontmatter 声明了
 * `allowed-tools: [Read, Write, Edit, AskUserQuestion]`，而全仓无任何解析器/执行器
 * 消费该字段：它既不是权限，也不是配额，只是给外部 agent 生态看的声明。
 *
 * 风险：若将来有人把该字段接成「技能可写任意文件」的授权来源，就是一个静默的提权
 * 通道（技能包来自外部，`skill_bundle.rs` 只做准入校验，不做运行期 IO 约束）。
 *
 * 本测试把「当前不消费」钉成契约：一旦有人新增消费点，测试变红，强制走评审，
 * 而不是让权限语义悄悄生效。
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const SCAN_ROOTS = ["src", "src-tauri/src"]

/** 递归收集 .ts/.tsx/.rs 源文件（跳过测试文件自身与 node_modules）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "target" || entry === "dist") continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collectSources(full, out)
    } else if (/\.(ts|tsx|rs)$/.test(entry) && !/\.spec\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe("Q20 技能沙盒契约：allowed-tools 不得被当作授权", () => {
  const sources = SCAN_ROOTS.flatMap((root) => collectSources(join(REPO_ROOT, root)))

  it("扫描面非空（防止路径漂移导致空跑通过）", () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it("全仓无代码消费 SKILL.md 的 allowed-tools 字段", () => {
    const offenders = sources.filter((file) => {
      const text = readFileSync(file, "utf8")
      // 匹配 allowed-tools / allowedTools / allowed_tools 的读取或解析
      return /allowed[-_]?tools/i.test(text)
    })
    expect(offenders).toEqual([])
  })

  it("技能包工具分类只做格式校验，不含执行授权语义", () => {
    // pack-format 的 PACK_TOOL_CATEGORIES 是「声明合法性」校验（readable-state /
    // writable-artifact 两类），不是权限授予；此处钉住其取值不扩张为执行类工具。
    const packFormat = readFileSync(
      join(REPO_ROOT, "src/lib/novel/skill-pack/pack-format.ts"),
      "utf8",
    )
    const match = packFormat.match(/PACK_TOOL_CATEGORIES\s*=\s*\[([^\]]*)\]/)
    expect(match).not.toBeNull()
    const categories = (match?.[1] ?? "")
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
    expect(categories).toEqual(["readable-state", "writable-artifact"])
  })
})
