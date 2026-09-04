import path from "path"
import { readFileSync } from "fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST

// Read version from package.json at config-load time so the Settings
// UI can show the running app version without duplicating the string.
const pkgJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // 浏览器/Tauri-webview 环境 node:* 外部化崩溃 shim（vitest 走真 Node，不 alias）：
      // 生产主路径零 fs（内嵌种子），shim 保证模块求值不崩、FS 路径降级。
      ...(process.env.VITEST
        ? {}
        : {
            "node:fs/promises": path.resolve(__dirname, "./src/lib/novel/browser-fs-shim.ts"),
            "node:fs": path.resolve(__dirname, "./src/lib/novel/browser-fs-shim.ts"),
            "node:path": path.resolve(__dirname, "./src/lib/novel/browser-path-shim.ts"),
            "node:url": path.resolve(__dirname, "./src/lib/novel/browser-url-shim.ts"),
          }),
    },
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 700,
    modulePreload: {
      resolveDependencies(_filename: string, deps: string[]) {
        return deps.filter((dep) => !dep.includes("graphology-vendor"))
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("react") || id.includes("scheduler")) {
              return "react-vendor"
            }
            if (id.includes("@milkdown")) {
              return "milkdown-vendor"
            }
            if (id.includes("katex") || id.includes("remark-math") || id.includes("rehype-katex")) {
              return "katex-vendor"
            }
            if (id.includes("cytoscape")) {
              return "cytoscape-vendor"
            }
            if (id.includes("@react-sigma") || id.includes("sigma")) {
              return "sigma-vendor"
            }
            if (id.includes("graphology")) {
              return "graphology-vendor"
            }
          }
          // Split large book-analysis modules into their own chunk
          if (id.includes("/src/lib/novel/book-analysis/")) {
            return "book-analysis-vendor"
          }
          return undefined
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 2420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 2421,
        }
      : undefined,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/.vite/**",
        "**/.novel/**",
        "**/chapters/**",
        "**/wiki/**",
        "**/target/**",
        "**/*.snapshot.*",
        "**/*.json",
        "**/*.store",
      ],
    },
  },

  test: {
    environment: "node",
    // Include bench files alongside test/spec so `npm run bench` works.
    // Default test:mocks/test:llm commands exclude *.bench.ts via their
    // own --exclude patterns or don't glob them.
    include: [
      "**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "**/*.bench.ts",
    ],
    // node:test 资产 (node --test 运行, vitest 不收集): residual-rewrite-toolkit
    // 的 smoke spec 用 node:test API, vitest include 模式会匹配 *.spec.mjs 但
    // 0 测试注册 → 文件级 "No test suite found" 失败。排除, 保持其 node --test 运行方式。
    // 注意: 显式 exclude 会覆盖 vitest 默认排除 (node_modules/dist 等), 必须完整继承。
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "e2e/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "scripts/residual-rewrite-toolkit.spec.mjs",
    ],
    // Loads .env.test.local into process.env for real-LLM tests.
    // The loader itself is a no-op if the file is absent, so this is
    // safe to keep on for every test run.
    setupFiles: ["./src/test-helpers/load-test-env.ts"],
    // CI flaky 止血（2026-08-22 三模型裁决，见 .workflow p1-flaky-debt）：
    // 仅 CI 重试 2 次（GA 默认 CI=true），本地 retry=0 保持 loud fail 不掩盖；
    // 确定性失败重试后仍红，真回归门信号保留；sunset：根因修复入 master 且
    // CI 连续绿跑后删除此行。
    retry: process.env.CI ? 2 : 0,
    // T5 flaky 治理（2026-08-23）：forks pool 全量并发下 worker 启动握手超时
    // （B 类）+ 5s testTimeout 被 CPU 争抢击穿（A 类）——限流到 4 worker 同时
    // 缓解两类；代价是全量跑更慢（263-344s → ~400-500s）。
    poolOptions: {
      forks: {
        maxWorkers: 4,
      },
    },
    // 覆盖率基线（2026-08-16 战役启动）：全口径 s/l/b/f，目标 100%（白名单排除）
    // 测量命令：npm run test:coverage
    // 白名单（7 项，analyze 冻结）：
    //   src/main.tsx 入口 / src/i18n/index.ts 初始化副作用 / src/config/help-links.ts 纯 URL 数据 /
    //   src/types/*.ts 纯 interface / src/test-helpers/** 测试工具 / src/vite-env.d.ts 类型声明
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{spec,test}.ts",
        "src/**/*.{spec,test}.tsx",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/i18n/index.ts",
        "src/config/help-links.ts",
        "src/types/**",
        "src/test-helpers/**",
        "src/lib/novel/vendor/**",
        "src/lib/novel/__fixtures__/**",
      ],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        // 58 号 C 共识：100/100/100/100 结构性不可达（57A 实测 lines 82%）
        // → 分层阈值：全局基线 + 核心写作主链高保护
        // 注：vitest 支持对象 key 为 glob；此处保留全局四维基线，
        //     核心模块高保护在政策文档中以定向测量命令执行
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
}))
