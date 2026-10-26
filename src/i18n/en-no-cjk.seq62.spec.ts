import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// ISS-20260712-023 (backlog seq62): en.json 曾出现中文值泄漏
// （app.title='屏墓AI写作'、novel.nav sources/graph 等中文值）。
// 本用例把"英文包零 CJK"钉住：en.json 全部字符串值不得含 CJK 字符。
// 若未来确需在 en 包保留个别 CJK（如品牌名），走 EN_CJK_ALLOWLIST 并注明理由。

const EN_CJK_ALLOWLIST: string[] = [
  // 目前零例外，保持空；新增例外必须附理由注释。
]

const CJK_RE = /[\u4e00-\u9fff]/

function collectStrings(node: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof node === "string") {
    out.push({ path, value: node })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out))
    return
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectStrings(v, path ? `${path}.${k}` : k, out)
    }
  }
}

describe("ISS-20260712-023 seq62 — en.json 零中文值", () => {
  it("en.json 字符串值不含 CJK（app.title/novel.nav 历史泄漏点已纠正）", () => {
    const raw = readFileSync(join(__dirname, "en.json"), "utf8")
    const en = JSON.parse(raw) as unknown
    const all: Array<{ path: string; value: string }> = []
    collectStrings(en, "", all)
    const leaks = all.filter(
      ({ path, value }) => CJK_RE.test(value) && !EN_CJK_ALLOWLIST.includes(path),
    )
    expect(
      leaks,
      `en.json 中文值泄漏 ${leaks.length} 处: ${leaks
        .slice(0, 10)
        .map(({ path, value }) => `${path}=${value.slice(0, 40)}`)
        .join("; ")}`,
    ).toEqual([])
  })

  it("历史泄漏点现行值为英文", () => {
    const en = JSON.parse(readFileSync(join(__dirname, "en.json"), "utf8")) as {
      app?: { title?: string }
      novel?: { nav?: Record<string, string> }
    }
    expect(en.app?.title).toBe("Niko Buddy")
    expect(en.novel?.nav?.sources).toBe("Outline")
    expect(en.novel?.nav?.graph).toBe("Novel Graph")
  })
})
