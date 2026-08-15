import { test, expect } from "@playwright/test";

// 冒烟：应用在浏览器环境能启动并渲染根节点。
// 纯 vite dev 环境（无 Tauri shell）下允许 Tauri IPC 调用降级，因此不把
// pageerror 作为硬断言；只验证「根节点非空 + 标题正确」这一启动契约。
test("app boots: title and root render", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("青幕AI写作");
  await expect(page.locator("#root")).not.toBeEmpty();
});
