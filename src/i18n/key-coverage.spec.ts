import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// @vitest-environment node
// 回归守卫：r3 清零 160 缺键后，后续特性又漂移出 14 个（2026-09-13 修复 58903e2c）。
// 本测试把键位一致性检查固化进 CI：任何新增 t('key') 字面量调用必须在 zh/en 双语资源中存在。

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, acc)
    else if (/\.(tsx?|ts)$/.test(name)) acc.push(p)
  }
  return acc
}

function flatten(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  )
}

describe("i18n key coverage (regression guard)", () => {
  const root = join(__dirname, "..", "..")
  const zh = JSON.parse(readFileSync(join(root, "src/i18n/zh.json"), "utf8")) as Record<string, unknown>
  const en = JSON.parse(readFileSync(join(root, "src/i18n/en.json"), "utf8")) as Record<string, unknown>
  const zhKeys = new Set(flatten(zh))
  const enKeys = new Set(flatten(en))

  it("zh/en locale key sets are identical", () => {
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k))
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k))
    expect(missingInEn, `keys missing in en.json: ${missingInEn.join(", ")}`).toEqual([])
    expect(missingInZh, `keys missing in zh.json: ${missingInZh.join(", ")}`).toEqual([])
  })

  it("every literal t('key') call site exists in both locales", () => {
    const srcDir = join(root, "src")
    const files = walk(srcDir).filter((f) => !f.includes(".spec."))
    const used = new Set<string>()
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      for (const m of text.matchAll(/\bt\(\s*['"]([\w.\-]+)['"]/g)) {
        used.add(m[1])
      }
    }
    expect(used.size, "sanity: literal key call sites should be found").toBeGreaterThan(1000)
    const missing = [...used].filter((k) => !zhKeys.has(k) || !enKeys.has(k))
    expect(
      missing,
      `t() keys missing from locale files (fix: add to zh.json AND en.json, or pass defaultValue + document): ${missing.join(", ")}`,
    ).toEqual([])
  })

  it("every template-literal t(`prefix.${x}`) has a real container key in both locales", () => {
    const srcDir = join(root, "src")
    const files = walk(srcDir).filter((f) => !f.includes(".spec."))
    const prefixes = new Set<string>()
    // 仅校验静态前缀（插值部分的值域在代码里不可静态得知），防止 novel.reviewCenter.dimension.${k}
    // 这类「前缀根本不存在 → 渲染出原始 key」的漂移。
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      for (const m of text.matchAll(/\bt\(\s*`([\w.\-]+)\.\$\{/g)) {
        prefixes.add(m[1])
      }
    }
    expect(prefixes.size, "sanity: template-literal key prefixes should be found").toBeGreaterThan(3)

    const zhFlat = flatten(zh)
    const enFlat = flatten(en)
    const hasContainer = (obj: Record<string, unknown>, flat: string[], dotted: string): boolean => {
      // 1) 嵌套容器：a.b → { x: ... }
      let cur: unknown = obj
      let nested = true
      for (const part of dotted.split(".")) {
        if (typeof cur !== "object" || cur === null || !(part in (cur as Record<string, unknown>))) {
          nested = false
          break
        }
        cur = (cur as Record<string, unknown>)[part]
      }
      if (nested && typeof cur === "object" && cur !== null && Object.keys(cur as Record<string, unknown>).length > 0) {
        return true
      }
      // 2) 扁平点号键：backup.cloud.decision.apply 这类直接以字面量存在顶层
      return flat.some((key) => key.startsWith(`${dotted}.`))
    }

    const broken = [...prefixes].filter(
      (p) => !hasContainer(zh, zhFlat, p) || !hasContainer(en, enFlat, p),
    )
    expect(
      broken,
      `template key prefixes missing from locales (fix the prefix or add keys): ${broken.join(", ")}`,
    ).toEqual([])
  })
})
