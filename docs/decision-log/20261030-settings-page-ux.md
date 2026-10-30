# 20261030 设置页交互与可访问性优化

> 执行：session-bdb27738。掌舵人 2026-10-30 授权（"通过 ui-ux-pro-max 优化 UI 选项/布局与交互"，范围选"整个设置页"）。
> 分工：父代理负责共享件与 settings-view 编排；子代理 A 负责模型域分区（llm / rerank / embedding / mcp 及其控件），子代理 B 负责存储与其余分区。复核由独立上下文子代理只读完成，结论见文末。
> 范围：`release/v2.22.2` 工作区，未 commit / push。依据 ui-ux-pro-max 优先级：可访问性 > 交互 > 布局 > 文字与配色 > 表单反馈 > 导航。

## 一、决策条目

| date | task_id | decision_type | value | evidence_ref |
|------|---------|---------------|-------|--------------|
| 2026-10-30 | UX-A4 | 手设参数 | 设置页所有开关统一为 `SettingsSwitch`：`role="switch"` + `aria-checked`，可访问名固定（"启用 {name}" 或可见标签），状态只放 aria-checked；轨道 44×24，焦点环 `focus-visible:ring-2`，滑块动画尊重 `motion-reduce` | `src/components/settings/settings-widgets.tsx` |
| 2026-10-30 | UX-A10 | 手设参数 | 有范围的数字输入统一为 `CommitNumberInput`：本地文本态，失焦或 Enter 提交，Esc 还原；越界在提交时夹值，空值或非数字还原（可选字段传 `onClear` 时清空即回默认）；输入中只在超过上限时标 `aria-invalid`（低于下限可能是没输完，比如想输 18 先敲 1，不标红，离开时夹到下限）；聚焦编辑期间外部 value 变化不覆盖输入。复核后补齐 rerank maxCandidates、Codex 超时、maxOutputTokens 三处原先每键夹值的输入；小说页小数项复用同一组件（`decimal`）。不含范围的文本型数字框（embedding 维度等）仍每键回写，见 DEBT-20261030-09 | `settings-widgets.tsx`；`settings-number-helpers.ts` |
| 2026-10-30 | UX-A18 | 手设参数 | 新增 `--success-foreground` / `--warning-foreground` 与 Tailwind `text-*-foreground` 工具类。亮色主题取更深的 oklch（L≈0.45），满足浅底文字对比度；暗色与深蓝主题沿用原色；护眼主题单独取值 | `src/index.css` |
| 2026-10-30 | UX-A3 | 手设参数 | 草稿重同步改为按字段合并：同一项目内 store 变化（如开关自动保存）时，草稿值仍等于旧基线的字段取新基线，已改动的字段保留；切换项目才整份重建。uiLanguage 始终保留草稿值 | `settings-view-helpers.ts` `mergeResyncedDraft`；`settings-view.tsx` |
| 2026-10-30 | UX-A8 | 手设参数 | 保存按钮加进行中状态（Loader2 + `aria-busy`，进行中重复点击忽略），失败时 `toast.error(t("settings.saveFailed"))` 并保留草稿与改动标记。各子配置先落盘、成功后才写 store，落盘失败的字段基线不变、保持"未保存"（复核 M1）；状态文案区 `role="status" aria-live="polite"`。按钮在无改动时仍可点击（保存本域当前值，spec 依赖），只用 outline / default 样式区分有无改动 | `settings-view.tsx` `handleSave` |
| 2026-10-30 | UX-A9 | 手设参数 | 保存栏按分类显示：草稿类（llm / rerank / embedding / network / interface / novel）显示按钮与保存范围；mcp 只显示"自动保存"说明；其余信息页不显示保存栏。保存范围文案替换原硬编码的"（模型域/存储域/界面域 · 仅保存本域）"；其它域有未保存改动时提示去对应页保存 | `settings-nav-config.ts` `SETTINGS_SAVE_MODE` |
| 2026-10-30 | UX-A14 | 手设参数 | 侧栏按 5 组显示：模型与工具（llm、rerank、embedding、mcp）、写作（novel、技能库）、应用（界面、网络）、数据（数据管理、维护）、帮助与支持（使用指南、反馈、联系支持、更新日志）。每组 `role="group"` + `aria-labelledby`，按钮带 `data-settings-category` 与焦点环。CATEGORIES 字面量与 CategoryId 联合类型留在 settings-view.tsx（源码 spec 断言） | `settings-nav-config.ts` `SETTINGS_NAV_GROUPS` |
| 2026-10-30 | UX-BUG-1 | 裁决人 | `maxHistoryMessages` 改归存储域：它在小说页编辑、按项目落盘，原归界面域导致在小说页点保存不写入。相应把 spec「novel 域保存不写 saveMaxHistoryMessages」改为断言会写入，并新增「界面域保存不再写它」 | `settings-view.spec.tsx`；`SETTINGS_DOMAIN_DRAFT_KEYS.storage` |
| 2026-10-30 | UX-A16 | 手设参数 | `SettingsCategoryId` 补 `"skill-library"` 与 `"mcp"`，深链接与 store 类型一致 | `src/stores/wiki-store-config.ts` |
| 2026-10-30 | UX-A1/A5/A6/A17/A19 | 手设参数 | 模型域（子代理 A）：MCP 警告框改 `role="note"` 与可读配色（原文字与背景同色）；折叠标题与 chevron 合并为一个带 `aria-expanded`/`aria-controls` 的按钮；chip 移除按钮 24px 带"移除 {name}"；去掉 `ring-0`/`outline-none` 改 focus-visible 焦点环；Label 经 useId + htmlFor 关联；19 个新 i18n 键；`String(error)` 改 `toErrorMessage`；非桌面端不再把内部码 `desktopOnly` 显示给用户 | 子代理 A 报告；10 个 spec 172 测试 |
| 2026-10-30 | UX-B | 手设参数 | 存储与其余分区（子代理 B）：新增 `sections/novel-section-panels.tsx`（NovelSwitchRow / NovelNumberField / NovelDecimalField / NovelExperimentalDetails 等），小说页数字项失焦提交、写入失败回滚并 toast、实验项收进 `<details data-testid="novel-experimental-details">`、分组标题改 h3；向量健康卡重建改二次确认 + destructive 按钮；界面 / 数据管理 / 维护的 Label 关联与单选组 `role="radiogroup"`；更新日志展开按钮 `min-h-6` + `aria-expanded`；`*-foreground` 色类替换浅底同色文字。顺带修 2 个 bug：内容装配页开关标签重复；反馈窗口开关把提示文字当成了可访问名 | 子代理 B 报告 |
| 2026-10-30 | UX-A21 | 手设参数 | 复核收尾：保存期间及结束后一拍，本域中基线变化的字段直接采用新基线（`mergeResyncedDraft` 的 adoptKeys），trim / clamp 后的实际存储值回到草稿（复核 M2）；小说页自动保存失败只回滚本次 patch 的键，以最新草稿为底，期间改的其它项不被冲掉（m2）；`parseClampedInt` / `parseClampedDecimal` 移到 `settings-number-helpers.ts`，`NOVEL_GROUP_HEADING_CLASS` 移到 `novel-section-style.ts`，原位置 re-export（m6）；更新日志下载按钮 12px→14px（m7 部分）；去掉 persistInterfaceDomain 未用依赖、"已保存"计时器卸载时清理、两处 checkbox 缩进（n1 / n2 / n7） | `settings-view.tsx`；`settings-view-helpers.ts`；`novel-section.tsx`；新增 spec 4 条（失败保持未保存、只回滚 patch 键、adoptKeys、数字解析） |
| 2026-10-30 | UX-A20 | 手设参数 | 父代理收尾：更新日志"发现新版本 / 已下载"横幅原为文字与背景同色（`text-warning` 叠 `bg-warning`、`text-success` 叠 `bg-success`），按钮白字叠浅黄 / 浅绿底；改为 `bg-*/10` 浅底 + `text-foreground` 正文，按钮改 `bg-primary text-primary-foreground` 加焦点环，横幅 `role="status"`、错误 `role="alert"`，✅ 换成图标。更新日志 12 条、反馈按钮 2 条、保存时代理 toast 3 条（错误经 `toErrorMessage`）、webhook 两个输入框的 aria-label 改走 i18n（zh / en 同步新增 19 键）；changelog spec 的 t mock 补 `{{param}}` 插值，断言文本不变 | `changelog-section.tsx`；`feedback-section.tsx`；`webhook-section.tsx`；`settings-view.tsx` 保存代理段 |

## 二、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261030-01 | 删除自定义模型配置等处仍用原生 `window.confirm`，与 LE-5 Radix Dialog 规范不一致（A13 共享 ConfirmDialog 未做） | 新增任一设置页确认弹窗，或下次设置页改版 | 下一个 minor 版本收口时复审 |
| DEBT-20261030-02 | API 模式按钮组没有 `role="group"` 与组标签，Label 无法 htmlFor；建议在 settings-widgets 加共享 SegmentedControl | 同上 | 同上 |
| DEBT-20261030-03 | `model-select-input.tsx:33` 与 `context-size-selector.tsx:80` 两处文案未走 i18n（纯函数里拼接，spec 精确断言） | 改动这两个文件时一并处理 | 同上 |
| DEBT-20261030-04 | 设置项搜索（A15）未做 | 用户反馈找不到设置项 | 待定 |
| DEBT-20261030-05 | 小说页逗号分隔类输入（如禁用词）仍每键回写 store，未改为失焦提交 | 改动该输入或收到卡顿反馈 | 下一个 minor 版本收口时复审 |
| DEBT-20261030-06 | `ChatModelSelector` 不接受 name / aria-label 属性，所在行只能靠外层 Label 文本 | 改动 ChatModelSelector | 同上 |
| DEBT-20261030-07 | 原生 checkbox 16px、MCP / 网络 / 数据管理页少量内联按钮小于 24px（扫描余 11 处） | 下次设置页改版 | 同上 |
| DEBT-20261030-08 | 技能库页标题、说明与内置技能描述为硬编码中文（`skill-library-section.tsx`），en 界面下仍显示中文 | 技能库开放编辑时一并做 i18n | 同上 |
| DEBT-20261030-09 | 无范围的数字 / 文本框（embedding 维度等 `embedding-section.tsx` 3 处、`llm-provider-widgets.tsx` 2 处）仍每键回写草稿或 store；不夹值，不会出现"清空变 1"，但每键触发保存或重渲染 | 改动这些输入时换成 CommitNumberInput | 下一个 minor 版本收口时复审 |
| DEBT-20261030-10 | 失焦提交的输入：输入后直接切页（未失焦即卸载）会丢掉这次输入；非法值只靠 `aria-invalid` 和还原，无可见错误文字；设置页没有"有未保存改动时离开"的拦截 | 收到丢输入反馈，或做设置页离开拦截 | 同上 |
| DEBT-20261030-11 | llm 页与小说页同时有自动保存项和草稿保存栏，"保存"按钮的范围提示无法覆盖自动保存项（复核 m1）；网络分组与存储域保存范围不完全对应（m8） | 下次设置页信息架构调整 | 同上 |
| DEBT-20261030-12 | 项目加载 effect 直接写草稿、不看改动标记（m3）：项目内异步加载完成晚于用户编辑时会覆盖该字段 | 收到相关反馈或改项目加载流程 | 同上 |
| DEBT-20261030-13 | 深蓝主题 `--primary` 上的白字对比约 3.0:1（14px 文字未达 4.5:1），属主题 token 问题，未在本轮改主题色（m7）；暗色主题焦点环与背景对比余量小 | 主题色复审 | 同上 |
| DEBT-20261030-14 | 代码整洁：CategoryId 联合类型与 SETTINGS_NAV_GROUPS 重复声明（n3，受源码 spec 约束）；saveScope 用前导空格拼接（n4）；aria-live 区域在每次改动时播报（n5）；部分按钮 title 与可见文字重复（n6）；保存失败无重试入口（需再点保存） | 改动 settings-view.tsx 保存栏时 | 同上 |

## 三、验证

- `npx vitest run src/components/settings src/i18n`：复核修复后 41 文件 486 passed（含 key-coverage、en-no-cjk）。
- 新增的两条失败路径 spec 做了反向验证：临时恢复"先写 store 再落盘"和"整份回滚"，两条均失败；恢复修复后通过。
- `npm run typecheck`：0 错（exit 0）。上一轮记录的 `chat-panel.tsx:19` TS6133 已由并行任务处理，本轮未动该文件。
- Playwright 逐页扫描 `e2e/settings-ux-walk.spec.ts`（vite preview 2437，按分类名对齐前后两轮）。合计：小于 24px 的点击目标 137→11，无可访问名控件 23→0，无 role 的开关 25→0，未关联控件的 label 62→0，带 aria-expanded 的折叠控件 0→51。分页：LLM small 47→0、switchNoRole 23→0；小说 small 55→4、unnamed 20→0、孤立 label 59→0；更新日志 small 24→0；维护 unnamed 2→0（webhook 两个输入框补 aria-label）。截图在 `.workflow/ui-audit-20261030-settings/shots/{before,after}/`。剩余 11 个 small 为原生 checkbox（16px）与 MCP / 网络 / 数据管理页内联小按钮，见 DEBT-20261030-07。
- 截图复查发现并修复：zh.json `settings.sections.changelog.current` 存的是字面量 `\\u2190`，页面显示成 "\u2190 当前版本"（HEAD 即有），spec 也断言了错误文本；已改为 "←" 并更新 spec。
- 预览环境下 CLI 探针卡显示 "Cannot read properties of undefined"：e2e 注入了部分 Tauri 全局，`isTauri()` 为真但 invoke 不可用，真机不会出现，未改。

## 四、残余与取舍

- 保存后采用新基线有一拍窗口（`setTimeout 0`）：窗口内若有本域字段被别处自动保存改动，也会直接采用 store 值。只影响刚保存的域，可接受。
- 小说页"先写 store 后落盘、失败回滚"的乐观更新保持不变，与草稿保存栏的"先落盘后写 store"不同：前者是即时开关，回滚有 toast；后者需要基线准确反映磁盘。
- llm 页的 LlmProviderSection 本身自动保存，页面仍显示草稿保存栏：同页的 rerank / embedding / multimodal 草稿属于模型域，spec 也依赖该按钮。
- 侧栏顺序变了（按组），使用者需要重新熟悉一次位置；分类名与图标不变。
- `text-info` 没有对应的 foreground token，未改。
- `cargo fmt --check` 全 crate 仍有约 57 处既有差异（19 个文件，非本轮改动）；本轮触及的 `agent_gate.rs`、`claude_cli_launch.rs` 已格式化干净，并保留原有 CRLF。

## 五、独立复核

独立复核子代理（只读、fresh 上下文）结论：无阻断项。主要问题与处理：

| 编号 | 问题 | 处理 |
|------|------|------|
| M1 | 保存时先写 store 再 await 落盘，落盘失败后基线已等于草稿，页面显示已保存 | 已修：先落盘后写 store；spec「保存失败：落盘失败的子配置不写 store，保存栏仍显示未保存」 |
| M2 | 保存时的 trim / clamp 结果不回到草稿，界面显示原始输入 | 已修：UX-A21 adoptKeys；单测覆盖 |
| M3 | 仍有三处每键夹值的数字框 | 已修三处；无范围的每键回写输入记 DEBT-09，UX-A10 措辞收窄 |
| m1 / m8 | 自动保存与草稿保存混用；网络分组与保存域不对应 | DEBT-11 |
| m2 | 小说页失败回滚整份覆盖并发改动 | 已修，spec 覆盖 |
| m3 | 项目加载 effect 不看改动标记 | DEBT-12 |
| m4 | 失焦提交在卸载时丢输入、无可见错误、外部值覆盖输入 | 外部值覆盖已修（聚焦时不同步）；其余 DEBT-10 |
| m5 | 向量重建新增的双重 `window.confirm` 与 DEBT-01 冲突 | 明确豁免：与数据管理页现有二次确认一致，随 DEBT-01（A13 共享 Radix ConfirmDialog）一起替换 |
| m6 | 纯函数 / 静态样式放在 panels 文件，小数输入重复实现 | 已修 |
| m7 | 深蓝主题 primary 小字对比约 3.0:1 | 按钮字号已调到 14px；token 问题记 DEBT-13 |
| n1 / n2 / n7 | 未用依赖、计时器未清理、缩进 | 已修 |
| n3–n6 | 类型重复、拼接、播报噪声、title 重复 | DEBT-14 |

复核同时确认：i18n 键集一致、switch / radiogroup / details 语义、foreground token 对比度通过。
