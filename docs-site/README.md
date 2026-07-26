# niko-hub 文档站

基于 [Astro](https://astro.build) + [Starlight](https://starlight.astro.build) 构建的 niko-hub 产品官网与技术文档站。

部署在 GitHub Pages：`https://smith-106.github.io/niko-hub/`

## 本地开发

```bash
cd docs-site
npm install
npm run dev
```

默认在 `http://localhost:4321/niko-hub/` 启动开发服务器。

## 构建

```bash
npm run build      # 产物在 docs-site/dist/
npm run preview    # 本地预览构建产物
```

## 目录结构

```
docs-site/
├── astro.config.mjs        # Astro + Starlight 配置（site/base/sidebar/locales）
├── package.json
├── src/
│   ├── content/            # Markdown 内容
│   │   ├── index.md        # 首页（产品门面）
│   │   ├── download.md     # 下载安装
│   │   ├── quickstart.md   # 快速开始
│   │   ├── features/       # 功能页（6 篇）
│   │   └── dev/            # 开发者文档（3 篇）
│   ├── layouts/
│   │   └── Home.astro      # 首页自定义 layout
│   └── styles/
│       └── custom.css      # 自定义样式
└── tsconfig.json
```

## 部署

通过 `.github/workflows/deploy-docs.yml` 自动部署。当 `release-b51ab03` 分支的 `docs-site/` 目录有改动并 push 时，GitHub Actions 自动构建并发布到 GitHub Pages。

仓库需在 Settings → Pages 启用，Source 设为 `GitHub Actions`。

## 添加内容

新增页面在 `src/content/` 下创建对应 `.md` 文件，并在 `astro.config.mjs` 的 `sidebar` 配置中登记条目。

## 内容真源

- 产品功能描述来自 QMAI README 与实际代码（v2.4.2）
- 技术架构来自 `docs/qmai-codex-delivery/` 交付文档包，已转译为面向用户/开发者的公开语言
- 阈值数据（absent/dormant）经 `scripts/calibrate-from-epub.mjs` 真实中文长篇样本校准
