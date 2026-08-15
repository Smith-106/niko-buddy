import { defineConfig } from "@playwright/test";

// 与 vite.config.ts 的 server.port 保持一致（strictPort: true）。
// 注意：本机 vite 只绑定 IPv6 localhost（::1），用 localhost 而非 127.0.0.1。
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
