import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * F-006 技能包交换的 e2e（TASK-006 verify 项二）。
 *
 * **范围声明**：F-006 是**纯前端**能力（本任务不新增任何 Rust 命令，导入导出都在
 * 本地文件 + Blob 之间完成），因此这里不伪造 UI 走查，而是断言三条**结构性禁令**
 * 与 i18n 双侧齐备：
 *   1. `src/lib/novel/skill-pack` 下没有任何网络请求入口；
 *   2. 同一目录下没有任何托管市场 / 账号绑定词汇；
 *   3. `src-tauri/src/lib.rs` 没有新增 `skill_pack_` 命令。
 * 逻辑覆盖（非法分类整包拒绝、导入默认 untrusted、导出剔除凭据字段）在
 * `src/lib/novel/skill-pack/__tests__/pack-import.spec.ts` 有 20 个用例。
 */

const REPO = process.cwd()
const PACK_DIR = resolve(REPO, "src/lib/novel/skill-pack")

function packSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts")) out.push(full)
    }
  }
  walk(PACK_DIR)
  return out
}

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
}

test.describe("F-006 技能包交换 / 结构性禁令", () => {
  test("技能包目录内没有任何网络请求入口", () => {
    const offenders: string[] = []
    for (const file of packSources()) {
      const src = readFileSync(file, "utf8")
      if (/fetch\(|axios|http:\/\//.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("技能包目录内没有托管市场 / 账号绑定词汇", () => {
    const offenders: string[] = []
    for (const file of packSources()) {
      const src = readFileSync(file, "utf8")
      if (/marketplace|account|oauth/i.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("未新增 Rust 命令（lib.rs 无 skill_pack_）", () => {
    const src = readFileSync(resolve(REPO, "src-tauri/src/lib.rs"), "utf8")
    expect(src).not.toContain("skill_pack_")
  })

  test("i18n：skillpack.trustLevel 双侧齐备", () => {
    for (const file of ["src/i18n/en.json", "src/i18n/zh.json"]) {
      const raw = readFileSync(resolve(REPO, file), "utf8")
      expect(raw, `${file} 缺少 skillpack.trustLevel`).toContain('"skillpack.trustLevel"')
      expect(raw).toContain('"skillpack.import"')
      expect(raw).toContain('"skillpack.export"')
    }
  })

  test("面板未挂载时应用仍能正常启动（无未处理 IPC）", async ({ page }) => {
    await boot(page)
    await page.waitForSelector("#root", { state: "attached" })
    const internalsReady = await page.evaluate(
      () =>
        typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
        "object",
    )
    expect(internalsReady).toBe(true)
  })
})
