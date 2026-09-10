import { defineConfig } from "@playwright/test";

// 与 vite.config.ts 的 server.port / preview.port 保持一致（strictPort: true）。
// 注意：vite 显式绑 127.0.0.1（Chromium 将 localhost 硬编码解析为 IPv4 loopback），
// baseURL 用 localhost 即可（三平台一致）。
const PORT = 2420;
const BASE_URL = `http://localhost:${PORT}`;

// R4（2026-09-10）冷启动根治：webServer 由 `vite dev` 改为 `vite build && vite preview`。
//
// 历史问题：dev 形态下首次请求要按需 transform 整图（T18 barrel 后 145 模块 + 各视图的
// 动态 import），CI runner（ubuntu/windows）上 `beforeEach` 的 `waitForSelector('#root')`
// 反复撞穿，靠把 test timeout 抬到 120s 硬扛；实测本批 10 个 run 中 4 个因该类红。
// 预构建产物把冷启动从「按需 transform 整图」降为「读一份已打包 JS」，因此 timeout 回到
// 常规量级（45s，含首个断言余量），不再依赖 120s 特例。
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run e2e:serve",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // 含一次 `vite build`（CI 上约 40-90s）+ preview 启动
    timeout: 240_000,
  },
});
