# 仓库卫生审计（2026-10-17，v2.17.0 发布批）

> 关联：`docs/README.md`（文档结构索引）、`.gitignore`（
> 一次性脚本与产物忽略规则）、knowhow `RCP-20261017-2304`（可复用核查清单）。

## 1. 结论

| 检查项 | 命令 | 结果 |
|--------|------|------|
| 远端可疑跟踪文件 | `git ls-files \| grep -Eic '\.(log\|tmp\|bak\|orig\|rej\|cache\|zip\|7z\|swp\|pyc)$ \| (^\|/)(tmp\|temp\|\.cache\|\.idea\|\.vscode\|__pycache__\|coverage\|playwright-report\|test-results)/ \| (^\|/)node_modules/ \| (^\|/)dist/'` | **0** |
| `node_modules/` 被跟踪 | `git ls-files \| grep -c node_modules/` | **0** |
| `docs-site/dist` 被跟踪 | `git ls-files docs-site/dist` | **0** |
| 本地产物/缓存 | `du -sh` 逐项 | 已清（见 §2） |

**远端无需删除提交**：仓库当前不存在需要 `git rm --cached` 的冗余跟踪项。

## 2. 本地清理（可再生产物，未入库）

| 路径 | 大小 | 处置 |
|------|------|------|
| `src-tauri/target` | 39G | 删除（Rust 构建缓存，发版由 CI 构建） |
| `node_modules/.vite` | 43M | 删除（Vite 依赖预打包缓存） |
| `dist` | 13M | 删除（前端构建产物） |
| `docs-site/dist` | 2.1M | 删除（文档站构建产物，重新构建可再生成） |
| `release-portable/` | 160M | 删除（历史便携版打包目录） |
| `test-results/`、`tsconfig.*.tsbuildinfo`、`nul` | — | 删除（测试产物 / 增量构建信息 / 误重定向产生的空文件） |

磁盘可用空间：929G → 968G。

## 3. 最大跟踪文件（必要性确认）

| 文件 | 大小 | 必要性 |
|------|------|--------|
| `src-tauri/assets/fonts/NotoSerifCJKsc-Regular.otf` | 23M | PDF/EPUB 导出的 CJK 嵌入字体，离线渲染必需 |
| `src-tauri/pdfium/pdfium.dll` | 7M | PDF 渲染引擎二进制，Windows 运行必需 |
| `src-tauri/icons/icon.icns` | 1.5M | macOS 图标资源（打包产物必需） |
| `src/assets/niko-buddy-logo.png` | 956K | 应用内品牌资源 |

## 4. 一次性脚本三分法（本次落地）

| 类别 | 处置 | 路径 |
|------|------|------|
| 本机取证/探针 | `.gitignore` 忽略（保留盘上） | `/scripts/probe-*.mts`、`/scripts/node-fs-{hook,register,shim}.mjs`、`/scripts/cdp-screenshot.py` |
| 可复用质量门/评测 | 入库 | `scripts/quality-gate-97-*`、`scripts/audit-modules.mts`、`scripts/rewrite-tier{1,2}.mts`、`scripts/ingest-*.mts` |
| E2E 审查用例 | 入库 | `e2e/ui-audit-walk.spec.ts` |

## 5. 文档结构治理

- 新增 `docs/README.md`：`docs/` 分区索引（治理与决策 / 规格与设计 / 阶段验收证据）+ 维护纪律
  （新增文档必须落既有分区；`generated/` 禁手改；语料与大样本不入库）。
- `/docs/*` 通配忽略导致新文档不显形：本次为 `docs/README.md` 补白名单（与既有
  `arch-decisions.md`、`decision-log/`、`p0/` 白名单同批维护）。

## 6. 后续约束

1. 新增 `docs/` 文件必须同批补 `.gitignore` 白名单，否则不会进库。
2. 新增一次性本机脚本放在已忽略的命名前缀下（`probe-*`），或直接写入 `scripts/` 并接受入库评审。
3. 发版前本地门禁必须跑齐 `typecheck` + `lint` + `test:mocks`（lint 的 `boundaries` 是 tag CI 会重跑硬门）。
