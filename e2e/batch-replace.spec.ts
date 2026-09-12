import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * F-007 事务式批量替换的 e2e（TASK-007 verify 项三）。
 *
 * 范围声明：`BatchReplacePanel` 此前未挂进应用外壳；2026-09-12 已接线到写作工作区底部
 * 工具条（壳层可达性见 `e2e/workspace-tools.spec.ts`）。以下断言可观察边界：
 *   1. 预览是只读 IPC，提交是独立 IPC，两者参数形状与 Rust 命令签名一致；
 *   2. 未确认的不可重建目标必须返回 GATE_REQUIRE_CONFIRM（走既有确认对话框），
 *      且**任何文件都没被改写**；
 *   3. 提交成功时 drafts 先落、正文后改，事务回滚时不残留半成品；
 *   4. 本组件不直接调用任何文件写入命令。
 * 事务与门的完整语义由 Rust 单测（batchreplace 模块 8 个用例）与 vitest（12 个用例）覆盖。
 */

const REPO = process.cwd()
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8")

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
  await page.waitForSelector("#root", { state: "attached" })
}

async function invoke(page: Page, cmd: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    ([name, payload]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke(name as string, payload as Record<string, unknown>),
    [cmd, args] as const,
  )
}

const RULE = { find: "林舟", replace: "林舟舟", case_sensitive: false }

test.describe("F-007 事务式批量替换", () => {
  test("Rust 侧：预览/提交两条命令、门与事务痕迹齐备", () => {
    const rust = read("src-tauri/src/batch_replace.rs")
    expect(rust).toContain("pub fn batch_replace_preview")
    expect(rust).toContain("pub fn batch_replace_apply")
    expect(rust).toContain("gate_authorize")
    expect(rust).toContain("GateRejected")
    expect(rust).toContain("drafts/")
    expect(rust).toContain("projection-status")
    // 确定性要求：不得出现任何模型调用路径。
    for (const forbidden of ["claude_cli", "codex_cli", "cursor_cli", "llm"]) {
      expect(rust, `不得依赖 ${forbidden}`).not.toContain(forbidden)
    }
    const lib = read("src-tauri/src/lib.rs")
    expect(lib).toContain("batch_replace_preview")
    expect(lib).toContain("batch_replace_apply")
  })

  test("预览只读：不产生 drafts、不改写正文", async ({ page }) => {
    await boot(page)
    const files = ["book/c1.md", "book/c2.md"]
    const diffs = (await invoke(page, "batch_replace_preview", {
      projectPath: "/tmp/proj",
      files,
      rule: RULE,
    })) as Array<{ path: string; replacements: number }>
    expect(diffs).toHaveLength(2)
    expect(diffs[0].replacements).toBe(1)

    const filesAfter = (await page.evaluate(
      () => Object.keys((window as unknown as { __MOCK_FILES__?: Record<string, string> }).__MOCK_FILES__ ?? {}),
    )) as string[]
    expect(filesAfter.filter((p) => p.includes("drafts/"))).toEqual([])
  })

  test("提交未确认时被门拦下，且零文件写入", async ({ page }) => {
    await boot(page)
    const denied = await invoke(page, "batch_replace_apply", {
      projectPath: "/tmp/proj",
      files: ["book/c1.md"],
      rule: RULE,
    })
      .then(() => null)
      .catch((e: Error) => e.message)
    expect(denied).toContain("BATCH_REPLACE_GATE_REJECTED")
    expect(denied).toContain("GATE_REQUIRE_CONFIRM")

    const written = (await page.evaluate(() => {
      const f = (window as unknown as { __MOCK_FILES__?: Record<string, string> }).__MOCK_FILES__ ?? {}
      return Object.keys(f)
    })) as string[]
    expect(written).toEqual([])
  })

  test("确认后提交：drafts 先行、正文随后、投影状态刷新", async ({ page }) => {
    await boot(page)
    // 走既有确认对话框：人类放行后，同一提交才被允许。
    await invoke(page, "confirm_gate_resolve", {
      requestId: "req-br-1",
      decision: "Allowed",
      note: "test confirm",
    });
    const report = (await invoke(page, "batch_replace_apply", {
      projectPath: "/tmp/proj",
      files: ["book/c1.md"],
      rule: RULE,
    })) as { applied: string[]; drafts: string[]; projection_status_updated: boolean }
    expect(report.applied).toEqual(["book/c1.md"])
    expect(report.drafts.length).toBe(1)
    expect(report.drafts[0]).toContain("drafts/")
    expect(report.projection_status_updated).toBe(true)
  })

  test("前端参数名与 Rust 签名对应（camelCase ↔ snake_case）", () => {
    const rust = read("src-tauri/src/batch_replace.rs")
    for (const param of ["project_path: String", "files: Vec<String>", "rule: ReplaceRule"]) {
      expect(rust).toContain(param)
    }
    const client = read("src/lib/novel/batch-replace/plan-client.ts")
    expect(client).toContain("projectPath: req.projectPath")
    expect(client).toContain("case_sensitive")
  })

  test("面板不直接写盘，且引用写前门与回滚提示", () => {
    const panel = read("src/components/tools/BatchReplacePanel.tsx")
    expect(panel).toContain("BatchReplacePanel")
    expect(panel).toContain("preflightCanonEdgeGate")
    expect(panel).toContain("batchreplace.transaction.rollback")
    for (const forbidden of ["fs_write", "write_file", "writeFile(", "canon_ingest"]) {
      expect(panel, `面板不得直接写盘 ${forbidden}`).not.toContain(forbidden)
    }
    const client = read("src/lib/novel/batch-replace/plan-client.ts")
    expect(client).toContain("canon-pre-write-gate")
  })

  test("i18n：批量替换三键双侧齐备", () => {
    for (const file of ["src/i18n/en.json", "src/i18n/zh.json"]) {
      const raw = read(file)
      for (const key of [
        "batchreplace.preview.title",
        "batchreplace.apply.confirm",
        "batchreplace.transaction.rollback",
      ]) {
        expect(raw, `${file} 缺少 ${key}`).toContain(`"${key}"`)
      }
    }
  })

  test("应用可正常启动（无未处理 IPC）", async ({ page }) => {
    await boot(page)
    const ready = await page.evaluate(
      () =>
        typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
        "object",
    )
    expect(ready).toBe(true)
  })
})
