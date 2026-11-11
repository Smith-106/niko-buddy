# 发布渠道与节奏策略（可机械检查化）

- 日期：2026-10-18
- 状态：生效
- 关联：`RELEASING.md`（发布规范）、`release-cadence-exemptions.json`（豁免登记）、`scripts/check-release-cadence.mjs`（机械检查）

## 背景

`RELEASING.md` 早已规定「stable 每周 ≤1、同日重复 tag = 0、近 30 天 stable ≤4」，但检查方式一直是人工核对
`gh release list` + CHANGELOG 日期链（65 号共识 G5）。人工核对的实际后果是：**规则存在、违规持续**——
截至 2026-10-18，仓库 54 个 stable 发布中有 12 个「多 stable 周」、7 个「多 stable 日」，
最密集的一周（2026-08-24）发了 14 个 stable。

因此把该硬检落成脚本，并把判定口径明确成两条，避免再次流于纸面：

1. **门禁只判「被审版本」**（默认 Latest，可 `--tag` 指定），不回头重判历史；
2. **历史违规以 INFO 汇总**输出，供审计可见，但不重复计罚。

## 渠道定义

| 渠道 | 标记 | 判定 | 谁在用 |
|---|---|---|---|
| stable | 非 `prerelease`、非 `draft` | `gh release edit --latest` 归属 Latest，updater 指向它 | 全体用户 |
| prerelease（内测） | `--prerelease` | 不进 Latest，updater 不指向 | 内测/验证 |

规则：**候选版一律先发 prerelease**，验证通过后再提升 stable。被审版本若本身是 prerelease，
节奏门不适用（`evaluateTarget` 返回空规则并给出 WARN）。

## 节奏规则（对 stable 生效）

| 规则键 | 判定 | 依据 |
|---|---|---|
| `weekly-stable` | 同一 ISO 周（周一为周首，本机时区）stable ≤ 1 | RELEASING「stable：每周 ≤1 个」 |
| `same-day-duplicate` | 同日本地日期 stable = 0（即同日最多 1 个） | RELEASING「同日重复 tag：重复 tag 一律拒绝」 |
| `thirty-day-stable` | 被审版本往前推 30 天内 stable ≤ 4 | RELEASING 发布后检查清单第 5 条（65 号共识 G5） |
| 资产 | `latest.json` + 安装包 `*.exe` 必有同名 `.sig`；`*_portable.exe` 按设计无 sig | RELEASING「资产命名（唯一规范）」。审 Latest 时 prerelease 标记本身判违规；`--tag` 指定的版本不是 Latest 时不判（只查资产与 draft） |
| 主干 | 被审版本 tag 必须是 `smith/master` 祖先 | RELEASING 发布后检查清单第 6 条 |

## 豁免流程

豁免是**例外而非常态**，必须同时满足：

1. 属 RELEASING 定义的 fix-forward 情形（资产补齐 / 断链 / 更新链路修复类补救发布）；
2. 用户明确批准；
3. 在 `release-cadence-exemptions.json` 登记 `tag` / `reason` / `approvedBy` / `approvedAt` / `scope`；
4. `scope` 必须逐条列出被豁免的规则键——未列入的规则照常判 FAIL（不会因登记而整体放行）。

已登记豁免：

| tag | 范围 | 理由 |
|---|---|---|
| v2.17.1 | `weekly-stable`、`thirty-day-stable` | fix-forward：修复 v2.17.0 遗留的 release 门禁缺陷（`gen-module-atlas` 跨环境字节漂移导致 `Generated artifacts check` 失败、tag 构建产不出资产），用户 2026-10-18 批准登记 |
| v2.18.0 | `thirty-day-stable` | 用户明确批准登记豁免（2026-10-19 会话决策）：v2.18.0 为门禁全绿的功能发布（动态工作热力/风格节奏雷达/资产联动与提取缺口/Agent 能力矩阵/冗余精简），发版当日本地四道硬门 + 全量 1169 files / 15214 tests 全绿；近 30 天 stable 计数超出上限属既有高频发布节奏所致，非跳过门禁。（批准于 2026-10-19） |
| v2.18.1 | `weekly-stable`、`thirty-day-stable`、`same-day-duplicate` | 用户明确批准登记豁免（2026-10-19 会话决策，选择「发补丁版 v2.18.1」）：v2.18.0 发版后 grok-4.7(xhigh) 终局对抗式审查判 BLOCK（无 P0，6 条 P1 + 5 条 P2），本补丁为修复性发布。same-day-duplicate 规则在此不适用其本意（该规则禁止的是同一 tag 当日重复，这里是 v2.18.0 → v2.18.1 两个不同 tag 的先后发布，未重打任何已发布 tag）。修复提交 b3ee292c 上全量 1174 files / 15265 tests 全绿，四道硬门全过，未跳过任何门禁。（批准于 2026-10-19） |
| v2.19.0 | `weekly-stable`、`thirty-day-stable`、`same-day-duplicate` | 用户明确批准（2026-10-19 会话，在本地真机安装 2.19.0 并运行后两次确认繼續）：15 灰卡转正功能版（WaveA/B/C 只读真实视图）+ 对抗审查修复。typecheck/lint/consistency/mocks/gen:check 全绿，Release CI success，Windows 三资产齐。tag 曾因 atlas 生成物漏 regen 导致门禁 failure，按纪律删除零资产旧 tag/release 后重打（未重打任何已发布带资产 tag），重打后 CI success 才重建 release。（批准于 2026-10-19） |
| v2.21.0 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-10-22 明确要求把 v2.21.0 由 prerelease 提升为正式版。原 tag 停在门禁失败、零资产的 a0431b43；修复已在 smith/master 且 CI 39731981080 全绿。零资产 tag 改指到该提交后由 Release 构建附上 Windows 安装包。同周已有 v2.20.0 stable，近 30 天 stable 亦超过上限。（批准于 2026-10-22） |
| v2.22.2 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-10-30 明确批准登记豁免：v2.22.2 为当前 Latest（v2.23.0 按 changelog 语义发为 prerelease），release:cadence 默认审 Latest 时因既有高频发布节奏 FAIL：ISO 周 2026-10-19 有 6 个 stable、发布前 30 天 stable 17 个（上限 4）。发版门禁当时全绿，超限不是跳过门禁。（批准于 2026-10-30） |
| v2.23.1 | `thirty-day-stable` | 用户于 2026-10-31 明确批准将 v2.23.1 由 prerelease 提升为 Latest 稳定版，使已装 2.22.2 的用户与作者能够通过内置更新器自动升级到包含 5 项遗留清理与 13 项 E2E 归零成果的版本。本周仅本版一个 stable（weekly-stable 满足）；发布前 30 天内 stable 计数 17 个超过历史上限 4 个，属历史连续高频发布所致，非跳过工程门禁；CI 41185560960 与 Release CI 41197993635 双全绿。（批准于 2026-10-31） |
| v2.24.0 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-11-01 明确批准将 v2.24.0 由 prerelease 提升为 Latest。v2.24.0 的 publishedAt 为 2026-11-01，与 v2.23.1（2026-10-31）同属 ISO 周 2026-10-26，该周 stable 计数为 2；近 30 天 stable 17 个属历史高频节奏。提升时四道硬门全绿、全量 16187 项单测与 E2E 27 项通过、独立复核 approve，Release CI 41224998281 与 CI 41225010889 双 success。（批准于 2026-11-01） |
| v2.24.1 | `weekly-stable`、`same-day-duplicate`、`thirty-day-stable` | 用户于 2026-11-01 明确批准 v2.24.1 以 stable 渠道发布并登记三项豁免：内容为图谱边线变细与可视性优化（caf2b37b 边宽基准下调与强度滑块 40~200、d15aaead 存储键重基）。ISO 周 2026-10-26 有 3 个 stable（v2.23.1 / v2.24.0 / v2.24.1）；2026-11-01 当日 stable 计数 2（v2.24.0 与 v2.24.1，不同 tag 先后发布、未重打已发布 tag）；发布前 30 天 stable 18 个（上限 4），属历史高频节奏所致，非跳过门禁。发版门禁全绿（typecheck 0 / lint eslint 0 + boundaries 5/5 / gen:check 6/6 / consistency 14/14 / test:mocks 16188 项 + graph-view 100 项），主干 CI 41261578283 与 Release CI 41263196143 双 success，节奏硬检 PASS。（批准于 2026-11-01） |
| v2.25.2 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-11-02 明确批准将 v2.25.2 由 prerelease 提升为 Latest 稳定版，目的是让已装 2.24.1 的用户能通过应用内更新器自动升级到该版本（同步备份 GitHub 私有仓三原语真机验收 + 冲突逐项决策 + 跨章稳定前缀缓存命中 + 缓存命中三层口径）。实际触发的硬检项为 thirty-day-stable（发布前 30 天 stable 数量超限，系历史连续高频发布所致，非跳过工程门禁）。weekly-stable 未触发：2026-11-02 为周一，属 ISO W45，该周仅此一个 stable；same-day-duplicate 未触发：2026-11-02 当日无其它 stable 发布。scope 仍保守登记 weekly-stable 以覆盖时区/周边界差异。发版门禁：typecheck 0、gen:check 6/6、consistency 14/14、CI 41424017897 全 6 job success、Release 41426695191 全 3 job success。（批准于 2026-11-02） |
| v2.26.0 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-11-03 明确批准将 v2.26.0 由 prerelease 提升为 Latest 稳定版，目的是让已装 2.25.2 的用户能通过应用内更新器自动升级到应用内 MCP 控制面 P0–P3 全量交付（17 个工具 / 会话分档与逐会话「完整写入」授权 / 直写审计与快照回滚）。规则事实：weekly-stable —— v2.25.2 发布于 2026-11-02、v2.26.0 发布于 2026-11-03，同属 ISO 周 2026-11-02，该周 stable 计数 2；thirty-day-stable —— 发布前 30 天 stable 18 个（上限 4），属历史连续高频发布所致，非跳过工程门禁。发版门禁：typecheck 0 / eslint 0 / boundaries 5/5 / gen:check 6/6 / consistency 14/14；Release CI 41592018442 全 3 job success，Windows 四资产齐。（批准于 2026-11-03） |
| v2.26.1 | `weekly-stable`、`same-day-duplicate`、`thirty-day-stable` | 用户于 2026-11-03 明确批准直接发 v2.26.1 稳定版，修复 Windows 上两条标题栏叠在一起（主窗口 decorations 从未设置，默认 true，与应用内 TitleBar 的无边框设计冲突），并补回此前缺失的四个窗口权限（应用内最小化/最大化/关闭按钮一直是死的，try/catch 静默吞掉权限拒绝）。规则事实（按本机时区 +0900 的本地日期计）：weekly-stable —— v2.25.2 本地 2026-11-02、v2.26.0 本地 2026-11-03、v2.26.1 本地 2026-11-04，同属 ISO 周 2026-11-02，该周 stable 计数 3；thirty-day-stable —— 发布前 30 天 stable 19 个（上限 4），属历史连续高频发布所致，非跳过工程门禁；same-day-duplicate —— 实际未触发（v2.26.1 本地 11-04，与前序 stable 不同日），此处作防御性预登记。发版门禁：typecheck 0、eslint 0 problem、vitest changelog 38 passed、boundaries 5/5、gen:check 6/6、consistency 14/14、cargo fmt --check PASS；Release CI 41658712333 success，Windows 四资产齐，latest.json version=2.26.1。（批准于 2026-11-03） |
| v2.26.2 | `weekly-stable`、`same-day-duplicate`、`thirty-day-stable` | 用户于 2026-11-04 批准直接发 v2.26.2 稳定版：v2.26.1 的无边框窗口在真机不生效（tauri-plugin-window-state 默认 StateFlags::all() 含 DECORATIONS，启动时用持久化的 decorated 值调 set_decorations()，把 tauri.conf.json 的 decorations:false 覆盖回 true），本版把 DECORATIONS 从恢复集排除。规则事实（按本机时区 +0900 的本地日期计）：weekly-stable —— ISO 周 2026-11-02 有 4 个 stable（v2.25.2 本地 11-02 / v2.26.0 本地 11-03 / v2.26.1 本地 11-04 / v2.26.2 本地 11-04）；same-day-duplicate —— 2026-11-04 当日 stable 计数 2（v2.26.1 与 v2.26.2，不同 tag 先后发布，未重打任何已发布 tag）；thirty-day-stable —— 发布前 30 天 stable 20 个（上限 4），属历史连续高频发布所致，非跳过工程门禁。发版门禁：cargo check --lib PASS、typecheck 0、eslint 0 problem、vitest changelog 38 passed、boundaries 5/5、gen:check 6/6、consistency 14/14、cargo fmt --check PASS。（批准于 2026-11-04） |
| v2.26.3 | `weekly-stable`、`same-day-duplicate`、`thirty-day-stable` | 用户于 2026-11-04 批准直接发 v2.26.3 稳定版：无边框改造后顶栏成为唯一窗口外框，侧栏顶部重复显示「Niko Buddy」需去掉；同时「总字数：N字」为 12px 低对比灰字、紧贴加粗标题导致读数不清，改为独立数据块（13px / font-medium / tabular-nums / text-foreground/80 + bg-muted 底）。规则事实（按本机时区 +0900 的本地日期计）：weekly-stable —— ISO 周 2026-11-02 有 5 个 stable（v2.25.2 本地 11-02 / v2.26.0 本地 11-03 / v2.26.1、v2.26.2、v2.26.3 本地 11-04）；same-day-duplicate —— 2026-11-04 当日 stable 计数 3（v2.26.1 / v2.26.2 / v2.26.3，均为不同 tag 先后发布，未重打任何已发布 tag）；thirty-day-stable —— 发布前 30 天 stable 21 个（上限 4），属历史连续高频发布所致，非跳过工程门禁。发版门禁：typecheck 0、eslint 0 problem、vitest layout+changelog+chapter-display 33 files 716 passed、boundaries 5/5、gen:check 6/6、consistency 14/14、cargo fmt --check PASS。（批准于 2026-11-04） |
| v2.26.4 | `weekly-stable`、`same-day-duplicate`、`thirty-day-stable` | 用户于 2026-11-04 明确要求发 v2.26.4 稳定版：主控三档权能补全 —— 主控 run 页签内可配置写作设置与 `aiWorkflowMode`、drafts 页签可采纳草稿（走同一 `acceptChapterDraft`，保留两步确认）、live 页签可重跑门控（判定仍归 `buildDecisionGates`）、深章阶段产出 / 共识写作 / 标题生成 / 记忆回填四项接进 trace 与 live、`autoGenerateChapterTitle` 从恒真变为真开关。规则事实（按本机时区 +0900 的本地日期计）：weekly-stable —— ISO 周 2026-11-02 有 6 个 stable（v2.25.2 本地 11-02 / v2.26.0 本地 11-03 / v2.26.1、v2.26.2、v2.26.3、v2.26.4 本地 11-04）；same-day-duplicate —— 2026-11-04 当日 stable 计数 4（v2.26.1 / v2.26.2 / v2.26.3 / v2.26.4，均为不同 tag 先后发布，未重打任何已发布 tag）；thirty-day-stable —— 发布前 30 天 stable 22 个（上限 4），属历史连续高频发布所致，非跳过工程门禁。发版门禁：typecheck / eslint / vitest 全量 / boundaries / gen:check / consistency / cargo fmt --check 全绿（详见本次发版门禁实测输出）。（批准于 2026-11-04） |
| v2.26.5 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-11-07 明确裁决发 v2.26.5 稳定版（三项裁决之一：发版走 v2.26.5 stable，并预先批准登记 weekly-stable + thirty-day-stable 两项豁免；另两项为阈值棘轮与真实构建 NSIS + portable 资产）。版本内容：设置页补齐 3 个有消费点无控件的字段（autoPlanningEnabled / residualCampaignIncludeFreezeChapters / journalTtlMs，默认值全未改动）、覆盖率门禁由 80/75/80/80 棘轮到 99.9/97/99.5/99.9（实测 99.99/97.55/99.80/99.98 全过）、NovelConfig 破坏性删除 writingModel 与两个真死字段（53→50 字段，线上行为零变化，旧键按留痕+告知处理）、主控轨迹快照 6 字段读回恢复、agent 装配层 load_context/planBlueprint/确定性武装三处接线、告知横幅永不渲染与模块热度脏快照致崩溃两处修复。规则事实（按 release:cadence 自身口径的本地周键）：weekly-stable —— ISO 周 2026-11-02 有 7 个 stable（v2.25.2, v2.26.0, v2.26.1, v2.26.2, v2.26.3, v2.26.4, v2.26.5）；same-day-duplicate 未触发（2026-11-07 当日仅本版一个 stable，未重打任何已发布 tag）；thirty-day-stable —— 发布前 30 天 stable 22 个（上限 4），属历史连续高频发布所致，非跳过工程门禁。发版门禁：typecheck 0 error / eslint 0 error + boundaries 5/5 / gen:check 6/6 / consistency 14/14 / 全量 test:mocks / cargo fmt --check，实测输出见本次发版记录。（批准于 2026-11-07） |
| v2.27.0 | `thirty-day-stable` | 用户于 2026-11-09 明确授权 v2.27.0 稳定版（含节奏豁免）。本版为本轮专家残余战役的收口版：MCP 一窗口全流程（auto 会话档 + 5 个编排工具真正注册）、深章产出落成可采纳草稿并回 artifactPath、pipeline.status 投影补 5 字段、普通草稿坞采纳后回填记忆并四态呈现、草稿 partial 标记、workflowMode 映射真实深度开关；修复三项真机暴露的阻断缺陷（采纳覆盖既有正式章保留 frontmatter、脏行前缀不被吞、容量类 503 退避重试）。按 RELEASING 机械口径实测（gh release 列表 + evaluateTarget 同源算法，本机时区 +0900 的 2026-11-09）：weekly-stable 未触发（ISO 周 2026-11-09 目前 0 个 stable，上一个 stable 在 2026-11-02 周）；same-day-duplicate 未触发（2026-11-09 尚无 stable）；thirty-day-stable 必然触发（发布前 30 天 stable 22 个，上限 4）——这是历史高频发布的结果，只能靠豁免。故 scope 只登记 thirty-day-stable，不顺手放宽未触发的规则。发布前本地硬门全绿：typecheck 0 error / eslint 0 error + boundaries / gen:check 6/6 / consistency 14/14 / test:mocks 1401 files + 22174 tests / e2e 88 passed / cargo test 全量 / cargo fmt --check。（批准于 2026-11-09） |
| v2.27.1 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-11-10 明确授权以 stable v2.27.1 发布应用内 MCP 元数据修补（`app.status` 按请求局部 scope 回报 `readOnly` + `scope`、`chapter.write` 描述指向 `.qm-drafts`），并预先批准登记本两项豁免。性质为补救性稳定补丁：已发布 v2.27.0 不含该修补，本版让外部 Agent 读到的自述权限与真实闸门一致。规则事实（`check-release-cadence.mjs` 同源算法 + gh release 列表 87 条，本机时区 +0900 的 2026-11-11 实测）：weekly-stable —— ISO 周 2026-11-09 现有 1 个 stable（v2.27.0@2026-11-09），本版令该周计数为 2；thirty-day-stable —— 2026-10-12 起累计 23 个稳定版，发布前 30 天 stable 23 个（上限 4），属历史连续高频发布所致，非跳过工程门禁；same-day-duplicate 未触发（2026-11-11 与前一 stable 2026-11-09 不同日），故未登记。仅豁免上述两项，类型 / lint / 测试 / 签名 / 安装 / 主干等硬门不变。（批准于 2026-11-10） |

> v2.17.1 与 v2.17.0 同 ISO 周（2026-10-12 → 10-18），属真实节奏超限，此处按 fix-forward 豁免登记，
> 而不是回改历史或把已发布版本降级为 prerelease（后者会让已升级用户收到降级提示）。

## 用法

```powershell
npm run release:cadence                 # 审 Latest
npm run release:cadence -- --tag v2.17.1
npm run release:cadence -- --json       # 机器可读（CI / 验收脚本）
```

退出码：`0` 通过（含豁免）/ `1` 有未豁免违规 / `2` 环境不可用（gh 或 git 失败）。

发布后检查清单里的人工「节奏审计」现由该脚本承担；`release-cadence-exemptions.json` 的任何新增
都必须在 release body 与本文档「已登记豁免」表中同步留痕。
