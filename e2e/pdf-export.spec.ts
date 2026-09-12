import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * F-008 PDF 导出的 e2e（TASK-008 verify 项二 + 项四的机械部分）。
 *
 * 范围声明：`PdfExportDialog` 此前未挂进应用外壳；2026-09-12 已接线到写作工作区底部
 * 工具条（壳层可达性见 `e2e/workspace-tools.spec.ts`）。以下断言可观察边界：
 *   1. 数据区路径在**本地**与**后端**各挡一次（`.novel` / `QM` / `.qmai` / `backups`）；
 *   2. IPC 参数名与 Rust 命令签名一致；
 *   3. 内嵌中文字体资产存在、且真产物里出现过字体名（verify 4 的机械证据，
 *      真实生成与回读由 Rust 单测 `pdfexport::exports_cjk_sample_with_embedded_font` 覆盖）。
 * 人工视觉核对（字形与 1.5 行距）留待执行报告逐项登记，命令 exit 0 不作为其替代。
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

test.describe("F-008 PDF 导出", () => {
  test("本地挡：数据区目标在调用前就被判为不可用", () => {
    const client = read("src/lib/export/pdf-client.ts")
    expect(client).toContain('".novel"')
    expect(client).toContain('"QM"')
    expect(client).toContain('".qmai"')
    expect(client).toContain('"backups"')
    expect(client).toContain("export function validateExportTarget")
    expect(client).toContain("isPathInsideDataSection")
    expect(client).toContain("LINE_HEIGHT_RATIO = 1.5")
  })

  test("后端挡：数据区路径被拒绝，且不产出任何文件", async ({ page }) => {
    await boot(page)
    for (const inside of [".novel/exports/book.pdf", "QM/out.pdf", ".qmai/x.pdf", "backups/x.pdf"]) {
      const message = await invoke(page, "export_pdf", {
        projectPath: "/tmp/proj",
        target: inside,
        title: "t",
        paragraphs: ["x"],
      })
        .then(() => null)
        .catch((e: Error) => e.message)
      expect(message, `${inside} 应被拒绝`).toContain("PDF_EXPORT_PATH_INSIDE_DATA_SECTION")
    }

    const produced = (await page.evaluate(
      () => Object.keys((window as unknown as { __MOCK_FILES__?: Record<string, string> }).__MOCK_FILES__ ?? {}),
    )) as string[]
    expect(produced).toEqual([])
  })

  test("数据区之外的目标可导出，并回报页数与字体", async ({ page }) => {
    await boot(page)
    const report = (await invoke(page, "export_pdf", {
      projectPath: "/tmp/proj",
      target: "exports/book.pdf",
      title: "样本",
      paragraphs: ["第一段", "第二段"],
    })) as {
      pages: number
      font: string
      line_height_ratio: number
      bytes_written: number
    }
    expect(report.pages).toBeGreaterThan(0)
    expect(report.font).toContain("NotoSerifCJKsc")
    expect(report.line_height_ratio).toBe(1.5)
    expect(report.bytes_written).toBeGreaterThan(0)
  })

  test("内嵌字体资产与真产物证据齐备", () => {
    const font = resolve(REPO, "src-tauri/assets/fonts/NotoSerifCJKsc-Regular.otf")
    expect(existsSync(font), "字体资产缺失").toBe(true)
    expect(statSync(font).size).toBeGreaterThan(1_000_000)

    const sample = resolve(REPO, "docs/p5/f008-sample.pdf")
    // 样本 PDF 内嵌完整 CJK 字体（约 20MB），属**生成物**且已 gitignore；
    // 未生成时跳过字节级校验，而不是把「缺文件」伪装成失败：
    //   cd src-tauri && cargo test --lib pdfexport::exports_cjk_sample_with_embedded_font
    test.skip(!existsSync(sample), "样本 PDF 未生成（生成物，已 gitignore）；先跑 cargo test --lib pdfexport")
    const bytes = readFileSync(sample)
    expect(bytes.length).toBeGreaterThan(10_000)
    // 字体名出现在 PDF 字节里 = 字体被嵌入而非仅被引用。
    expect(bytes.toString("latin1")).toContain("NotoSerifCJKsc")
  })

  test("Rust 侧：路径硬拦、字体与行距常量、命令注册", () => {
    const rust = read("src-tauri/src/pdf_export.rs")
    expect(rust).toContain("assert_export_path_outside_data_sections")
    expect(rust).toContain("PathInsideDataSection")
    expect(rust).toContain("pdfium")
    expect(rust).toContain("NotoSerifCJKsc")
    expect(rust).toContain("pub fn export_pdf")
    expect(read("src-tauri/src/lib.rs")).toContain("pdf_export::api::export_pdf")

    for (const param of ["project_path: String", "target: String", "paragraphs: Vec<String>"]) {
      expect(rust).toContain(param)
    }
    // 只读投影：导出模块不得出现写入记忆区/正文的入口。
    for (const forbidden of ["canon_ingest", "memory_patch", "QM/memory"]) {
      expect(rust, `导出不得写 ${forbidden}`).not.toContain(forbidden)
    }
  })

  test("i18n：PDF 导出三键双侧齐备", () => {
    for (const file of ["src/i18n/en.json", "src/i18n/zh.json"]) {
      const raw = read(file)
      for (const key of ["pdfexport.dialog.title", "pdfexport.font.cjk", "pdfexport.path.outsideData"]) {
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
