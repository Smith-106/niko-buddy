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
//   依赖方向规则（boundaries/element-types）：
//     from app        允许 novel-public + app，禁止 novel-internal；
//     from novel-*    允许 novel-internal + novel-public（域内自由组合）。
//   语义：外部只能经 novel-public barrel 导入 novel 能力，不得直接 import 内部模块。
//
//   严重级别定为 warn（而非 error）：
//     现状 75 个外部导入直连 novel-internal、顶层 barrel 缺失，T18 的窄接口重构尚未完成。
//     蓝图 §9.8 第 5 项明文「预留 eslint-boundaries 位（T18 依赖方向门禁前置）」——
//     本配置落地位、Taxonomy、resolver 全部就位；T18 完成 barrel 重构后将级别由 warn 升至
//     error 即可转为硬门（一行改动）。任务约束「0 error，warning 可接受」即此口径。
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
      'boundaries/elements': [
        {
          type: 'novel-public',
          pattern: ['src/lib/novel/index.ts', 'src/lib/novel/*/index.ts'],
          mode: 'full',
          capture: ['element'],
        },
        {
          type: 'novel-internal',
          pattern: 'src/lib/novel/**/*',
          mode: 'full',
          capture: ['element'],
        },
        {
          type: 'app',
          pattern: 'src/**/*',
          mode: 'full',
          capture: ['element'],
        },
      ],
      'boundaries/include': ['src/**/*.{ts,tsx,js,jsx}'],
    },
    rules: {
      'boundaries/element-types': [
        'warn',
        {
          default: 'disallow',
          rules: [
            // 外部（UI/IPC/编排层）只能经 novel-public barrel 进入 novel 能力域——
            // 这是蓝图明文的窄接口白名单门禁。
            { from: 'app', allow: ['novel-public', 'app'] },
            // novel 域内自由组合；并暂允许 novel→app（现状 novel/ 反向依赖 stores/commands/i18n
            // 等共 353 处，属更深的单向化债务）。T18 收口时可收紧此项为仅 novel-* 以强制单向。
            { from: 'novel-internal', allow: ['novel-internal', 'novel-public', 'app'] },
            { from: 'novel-public', allow: ['novel-internal', 'novel-public', 'app'] },
          ],
        },
      ],
    },
  },
);
