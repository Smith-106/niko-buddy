import { defineConfig } from "@playwright/test";

// 与 vite.config.ts 的 server.port 保持一致（strictPort: true）。
// 注意：vite 显式绑 127.0.0.1（Chromium 将 localhost 硬编码解析为 IPv4 loopback），
// baseURL 用 localhost 即可（三平台一致）。
const PORT = 2420;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
