import { test, expect } from "@playwright/test"
import { MOCK_INIT, collectErrors } from "./tauri-mock"

// 写作全流程实操检验（波 3 执行资产）
// 覆盖：新建项目对话框 → 主界面；打开章节 → AI 会话展开 → 写作对话（发送指令 → mock 流式回复渲染）；
//       深度模式开关切换。mock 回放 claude_cli_spawn token/done 事件。

async function openMockProject(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })
}

/** 展开 AI 会话：点击章节 → 预览面板章节头工具栏 → AI会话 按钮 */
async function expandChat(page: import("@playwright/test").Page) {
  await openMockProject(page)
  // 章节文件树 → 点击 chapter-001.md（节点 title 为完整路径）
  const chapterNode = page.locator('[title*="chapter-001.md"]').first()
  await expect(chapterNode).toBeVisible({ timeout: 10000 })
  await chapterNode.click()
  // 预览面板出现章节正文
  await expect(page.getByText("夜色沉静", { exact: false }).first()).toBeVisible({ timeout: 10000 })
  // 工具栏 AI会话 按钮 → 展开对话面板
  const chatBtn = page.getByRole("button", { name: "AI会话" })
  await expect(chatBtn).toBeVisible({ timeout: 10000 })
  await chatBtn.click()
}

test("备份导出：backupExport 视图 → 导出备份包 → 成功反馈", async ({ page }) => {
  const errors = collectErrors(page)

  await openMockProject(page)
  await page.click('[data-view="backupExport"]')
  await page.waitForTimeout(400)

  // 导出备份包按钮（mock plugin:dialog|save + export_backup）
  const exportBtn = page.getByRole("button", { name: /导出备份包/ })
  await expect(exportBtn).toBeVisible({ timeout: 10000 })
  await exportBtn.click()
  // 导出成功反馈
  await expect(page.getByText("导出成功").first()).toBeVisible({ timeout: 15000 })

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})

test.beforeEach(async ({ page }) => {
  test.setTimeout(120000) // vite dev 冷启动时 React 挂载可能超默认 30s（瞬态竞态加固）
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForSelector("#root")
})

test("新建小说项目：对话框填写 → 创建 → 进入主界面", async ({ page }) => {
  const errors = collectErrors(page)

  await page.getByRole("button", { name: "新建小说" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5000 })
  // 填写小说名称 + 目录路径（文本框直接填写，mock create_project）
  await dialog.getByPlaceholder("我的长篇小说").fill("测试小说")
  await dialog.getByRole("textbox", { name: "小说目录" }).fill("C:/mock/proj")
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  // 进入主界面（sidebar 出现）
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})

test("写作对话：打开章节 → 展开 AI 会话 → 发送指令 → 回复渲染", async ({ page }) => {
  const errors = collectErrors(page)

  await expandChat(page)

  // 聊天输入框发送写作指令（novel 模式 placeholder 为「输入写作需求...」）
  const input = page.getByPlaceholder(/输入写作需求|输入消息/)
  await expect(input).toBeVisible({ timeout: 10000 })
  await input.fill("写第一章")
  await input.press("Enter")

  // mock 回放（claude_cli_spawn → token → assistant 消息渲染）
  await expect(page.getByText("第一章 初见").first()).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})

test("深度模式开关：开启/关闭切换", async ({ page }) => {
  const errors = collectErrors(page)

  await expandChat(page)

  const deepToggle = page.locator('button[aria-label="开启深度模式"], button[aria-label="关闭深度模式"]')
  await expect(deepToggle).toBeVisible({ timeout: 10000 })
  // 开启
  await page.locator('button[aria-label="开启深度模式"]').click()
  await expect(page.locator('button[aria-label="关闭深度模式"]')).toBeVisible()
  // 关闭
  await page.locator('button[aria-label="关闭深度模式"]').click()
  await expect(page.locator('button[aria-label="开启深度模式"]')).toBeVisible()

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})
