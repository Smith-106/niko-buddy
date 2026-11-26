// ESLint flat config — 依赖方向门禁（boundaries/dependencies）+ 高信号代码质量/安全分层门禁。
//
// 1. 依赖方向门禁（narrow-interface whitelist）：
//    元素类型分层（首匹配优先，顺序敏感）：
//      - novel  —— src/lib/novel 领域本体；对外静态公开入口为顶层 barrel
//        （src/lib/novel/index.ts）与各子目录 barrel（src/lib/novel/*/index.ts），
//        动态按需加载走受控 `novel-deferred` 21 模块白名单。
//      - shared —— src/lib 其余共享基础层（与 novel 同属领域依赖闭包）。
//      - app    —— src 下其余一切（UI/IPC/编排层），仅可经 novel-barrel 或
//        novel-deferred 进入 novel 领域。
//    正/负 fixture 回归 `scripts/check-boundaries.mjs` 由 `npm run lint` 串联，
//    防止「元素分类失效→静默假绿」重现。
//
// 2. 分层高信号代码质量与安全规则（R3-E01）：
//    - Tier 1（error，CI 硬门）：react-hooks/rules-of-hooks（显式单规则，禁展开 v7 recommended）、
//      no-unsanitized/{method,property}、@typescript-eslint/ban-ts-comment、no-debugger。
//    - Tier 2（warn，渐进治理）：react-hooks/exhaustive-deps、@typescript-eslint/no-explicit-any
//      （测试与 src/test-helpers/** 豁免 no-explicit-any；src/**/*.generated.ts 豁免 ban-ts-comment）。

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

  // 分层高信号代码质量/安全规则（Tier 1 error + Tier 2 warn）。
  // 注意：eslint-plugin-react-hooks v7 的 configs.recommended 含 React Compiler 规则，
  // 此处仅显式启用核心规则，严禁展开 recommended；reportUnusedDisableDirectives 保持 off
  // 以兼容未启用规则的既有 eslint-disable 注释。
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'no-unsanitized': noUnsanitized,
    },
    rules: {
      // Tier 1（error）：Hooks 正确性、原生 DOM XSS 防护、禁无理由类型静默、禁遗留 debugger
      'react-hooks/rules-of-hooks': 'error',
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      'no-debugger': 'error',
      // Tier 2（warn）：依赖数组完整性与显式 any 渐进收口
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // 测试文件与测试脚手架：豁免 no-explicit-any（保留 Tier 1 全部 error 安全/Hooks 底线）
  {
    files: [
      'src/**/*.spec.{ts,tsx,js,jsx}',
      'src/**/*.test.{ts,tsx,js,jsx}',
      'src/test-helpers/**/*.{ts,tsx,js,jsx}',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // 生成物豁免：如 src/lib/novel/t2s-map.generated.ts 头部含生成器产出的 // @ts-nocheck，
  // 须保留逐字节可复现性（gen:check）而不触发 ban-ts-comment。
  {
    files: ['src/**/*.generated.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
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
            'src/lib/novel/consensus-writing.ts',
            'src/lib/novel/de-ai-adapter.ts',
            'src/lib/novel/deep-chapter-generation.ts',
            'src/lib/novel/delete-source-memory.ts',
            'src/lib/novel/memory-center.ts',
            'src/lib/novel/project-meta.ts',
            'src/lib/novel/residual-campaign.ts',
            'src/lib/novel/review-adapter.ts',
            'src/lib/novel/search-adapter.ts',
            // G3（TASK-004）：批量提取扫库/范围选择/队列。UI（知识树 / 图谱右键）与
            // sidebar-panel-import 的批量通道一律 `await import()` 按需加载——走 barrel
            // 会把整张 novel 模块图拖进延迟路径（见上方 T18 决策）。故登记为受控延迟叶子。
            'src/lib/novel/snapshot-scanner.ts',
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
