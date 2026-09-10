// ESLint flat config — §9.8 工程化清单第 5 项 / T18 依赖方向门禁前置。
//
// 自动判决说明（narrow-interface whitelist）：
//   元素类型分层（首匹配优先，顺序敏感）：
//     1) novel-public —— 顶层 barrel (src/lib/novel/index.ts) 与各子目录 barrel
//        （匹配 src/lib/novel 下任意子目录的 index.ts）。即 novel 对外「窄接口公开入口」。
//        当前仅 de-ai-batch / planning 子目录 barrel 存在，顶层 novel/index.ts 尚未建立
//        （T18 收口时补）。
//     2) novel-internal —— src/lib/novel 下其余全部内部模块（私有）。
//     3) app —— src 下其余一切（UI/IPC/编排层）。
//   依赖方向规则（boundaries/dependencies，2026-08-22 自弃用的 element-types 迁移，
//   语义与旧规则逐条等价——迁移前旧规则原文见 docs/decision-log/
//   20260822-eslint-gate-revival.md「旧规则意图存档」一节）：
//     from app        允许 to = novel-public + app，其余（含 novel-internal）默认禁止；
//     from novel-*    允许 to = novel-internal + novel-public + app（域内自由组合）。
//   语义：外部只能经 novel-public barrel 导入 novel 能力，不得直接 import 内部模块。
//
//   严重级别：**error（硬门）**。2026-09-10 T18-G 迁移后实测 violations 归零，棘轮
//     `--max-warnings` 已从 package.json 删除（棘轮史：162 → 100 → 0）。
//     正/负 fixture 回归 `scripts/check-boundaries.mjs` 由 `npm run lint` 串联，
//     防止「元素分类失效→静默假绿」重现。
//
// 不修改任何现有源码；仅新增本配置文件 + devDependencies。

import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import globals from 'globals';

export default tseslint.config(
  // 全局忽略：构建产物 / Rust 侧 / 测试临时 / 配置文件，不进入 boundaries 判定
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'src-tauri/**',
      'public/**',
      'docs/**',
      'docs-site/**',
      'analytics-worker/**',
      'scripts/**',
      'e2e/**',
      'extension/**',
      'playwright.config.ts',
      'vite.config.ts',
      'eslint.config.js',
      '.claude/**',
      '.codex-temp/**',
      '.worktrees/**',
      'superpowers*/**',
      'SKILL/**',
    ],
  },

  // 源码中既存的 eslint-disable 指令引用了 typescript-eslint / react-hooks / no-unsanitized
  // 的规则（§9.8 第 5 项完整 eslint 落地前的预留位）。此处仅「注册」这些插件使指令引用的规则
  // 成立（不再报 Definition not found），但不启用任何 recommended 规则集——保持唯一活跃
  // 的规则面为 boundaries 依赖方向门禁。未启用的 disable 指令视为 unused，下面统一静默。
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'no-unsanitized': noUnsanitized,
    },
  },

  // TS/TSX 解析基底（非类型感知，避免拉起完整 TS 服务）
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // eslint-plugin-boundaries：novel 窄接口依赖方向门禁
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    plugins: { boundaries },
    settings: {
      // 别名解析（tsconfig.app.json paths: "@/*" -> "./src/*"）
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
      },
      // v7 语义（2026-09-10 T18-G 迁移）：elements 只匹配「目录」，无法用文件粒度描述
      // 「barrel 公开、同目录其它文件私有」。因此元素退到目录粒度，公开面改由 file
      // descriptors（boundaries/files）+ 依赖策略里的 file 选择器表达。
      //   novel  = 领域本体（src/lib/novel）
      //   shared = 共享基础层（src/lib 其余部分）——novel 自身反向依赖它（如
      //            novel/chapter-ingest.ts 静态导入 @/lib/graph-relevance），故它属于
      //            novel 的依赖闭包内部；若也强制走 barrel 会形成 barrel↔shared 循环导入。
      //   app    = UI/IPC/编排层（src 其余）：唯一受「仅可经 barrel 进入 novel」约束的一层。
      'boundaries/elements': [
        {
          type: 'novel',
          pattern: 'src/lib/novel',
          capture: ['element'],
        },
        {
          type: 'shared',
          pattern: 'src/lib',
          capture: ['element'],
        },
        {
          type: 'app',
          pattern: 'src',
          capture: ['element'],
        },
      ],
      // 文件类别（仅文件粒度可用，与 elements 的目录粒度互补）：
      //   novel-barrel   —— novel 的静态公开入口：顶层 barrel + 子目录 barrel。
      //   novel-deferred —— 受控的「延迟公开面」：T18 决策明文「动态 await import() 保留
      //     叶子模块」（走 barrel 会把 145 模块图拖进延迟路径，实测单次冷加载 8.4s），
      //     故显式声明允许按需加载的叶子模块。本表来自实测的 app 侧动态导入清单，
      //     新增深导入若不在表内即被拦下（新增项须在评审中给出理由）。
      'boundaries/files': [
        {
          category: 'novel-barrel',
          pattern: ['src/lib/novel/index.ts', 'src/lib/novel/*/index.ts'],
        },
        {
          category: 'novel-deferred',
          pattern: [
            'src/lib/novel/agent-parser.ts',
            'src/lib/novel/agent-tools.ts',
            'src/lib/novel/canon-dual-write.ts',
            'src/lib/novel/chapter-ingest.ts',
            'src/lib/novel/context-engine.ts',
            'src/lib/novel/de-ai-adapter.ts',
            'src/lib/novel/deep-chapter-generation.ts',
            'src/lib/novel/delete-source-memory.ts',
            'src/lib/novel/memory-center.ts',
            'src/lib/novel/project-meta.ts',
            'src/lib/novel/residual-campaign.ts',
            'src/lib/novel/review-adapter.ts',
            'src/lib/novel/search-adapter.ts',
            'src/lib/novel/book-analysis/analysis-engine.ts',
            'src/lib/novel/book-analysis/character-disk-store.ts',
            'src/lib/novel/book-analysis/character-extraction-engine.ts',
            'src/lib/novel/book-analysis/character-llm-recognizer.ts',
            'src/lib/novel/book-analysis/simple-extraction-engine.ts',
            'src/lib/novel/book-analysis/skill-generator.ts',
          ],
        },
      ],
      'boundaries/include': ['src/**/*.{ts,tsx,js,jsx}'],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // app 层只能经 novel-barrel（静态公开入口）或 novel-deferred（受控延迟公开面）
            // 进入 novel 领域；其余 novel 文件均为私有。
            {
              from: { element: { type: 'app' } },
              allow: [
                { to: { element: { type: 'app' } } },
                { to: { element: { type: 'shared' } } },
                {
                  to: {
                    element: { type: 'novel' },
                    file: { categories: ['novel-barrel', 'novel-deferred'] },
                  },
                },
              ],
            },
            // shared 与 novel 同属领域依赖闭包（novel→shared 反向依赖已存在），互访全部放行。
            {
              from: { element: { type: 'shared' } },
              allow: [
                { to: { element: { type: 'app' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'novel' } } },
              ],
            },
            // novel 域内自由组合；并暂允许 novel→app（现状 novel/ 反向依赖 stores/commands/i18n
            // 等共 353 处，属更深的单向化债务）。T18 收口时可收紧此项为仅 novel-* 以强制单向。
            {
              from: { element: { type: 'novel' } },
              allow: [
                { to: { element: { type: 'novel' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'app' } } },
              ],
            },
          ],
        },
      ],
    },
  },
);
