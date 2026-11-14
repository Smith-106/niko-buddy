# 2026-11-13 — 草稿采纳后编辑区不刷新（G2-NATIVE-F1）现有组件增量修复

> task_id：S3 单件修复（run-fe6288c0ce65 / session 20261109-ralph-expert-residuals）
> status：**原fresh R6独立复核1/1已完整消费：approve_scoped、七路径7/7／0跳过、无域内材料性缺陷；按独立结论sourceAccepted=true／R1Complete=true仅原协调七路径源码腿，Root最终语义verdict仍null。复用机械249/249、force types0、五文件lint0及单目标atlas fresh字节一致。原13契约、收敛1/1／累积2、Root执行1、源码teammate5／基础设施中断3不变；P16源/spec `6f4db0d6` 与独立atlas `c832e2f3` 已本地提交，本记录为第三docs提交（自身SHA与父序在Run-local回执）；不推送/改版/发版，不宣称真机/MCP/当前源码实包/L9或全体正式写者已通过。**
> 当前依据：immutable `agent://d845a492-9263-4b12-90e7-cfc6fb864c84` 及 Run `run-fe6288c0ce65` 内 `work/g2-editor-redesign-after-source-review/root-direct-r1/{remaining-authority-155.json,remaining-consolidation155-verification.json,remaining-consolidation155-atlas-verification.json,remaining-consolidation155-review-outcome.json}`；原152/153授权、6红停线、7/7记录检查、旧F1 request_changes与中断原件保留历史范围。
> 初始F1基线：`head=f36f38c8b6f95853e7565b5d8bcc2ab2e4eabade`，当时tracked干净，10个 `scripts/l9-*` 未跟踪文件按原基线保留；不是当前工作树干净或当前候选通过的声明。
> 当前r6范围：**原五布局源码/spec锚点** —— `preview-panel-helpers.ts`、`preview-panel.tsx`、`writing-workspace.tsx`、两既有spec；仅现有组件编排，无新依赖/状态权威。`chapter-draft-dock.tsx` 未改，生成物及决策记录仍由Root单写者处理，失败期间不生成atlas。

## 一、决策条目

| 字段 | 值 |
|------|----|
| date | 2026-11-13（amend 于本轮同一授权内） |
| task_id | S3-G2-NATIVE-F1（editor refresh after adoption） |
| decision_type | U-裁决（UI 状态刷新口径 + 同文件写序口径） |
| value | **候选方案（未批准）**：采纳刷新用「采纳专用令牌」表达；同文件静默门目前只部分排序，不能保证所有在途写者。保持不新增 watcher/store、不改 Dock/Rust 的约束，须人控重设计裁决而非继续逐回调补锁。 ① `writing-workspace.tsx` 新增 `chapterAdoptionRefresh = {token, path}`（`:150`）与 `previewWriteGateRef`（`:152`）；② 令牌以**可选** props `adoptionRefreshToken` / `adoptionRefreshPath` 传给 `WritingWorkspace` 内**两个** `PreviewPanel` 挂载点（`:491-493`、`:528-530`）；③ `preview-panel.tsx` 装载 effect 只在「令牌变化 **且** 令牌指认当前文件 **且** 选中路径未变」时判为同路径采纳刷新（`:266-271`），重读磁盘后写回 `fileContent` + `lastLoadedRef`；④ **采纳写入之前**先调 `writeGate.begin(target)`（`writing-workspace.tsx:169-170`，实现 `preview-panel.tsx:432-465`）：作废本文件待写盘 → 置 `adoptionLockRef` 并清 `loadedFilePath`（复用既有装载守卫）→ 仅等单槽最后登记的 `write_file_atomic`（不能保证全部在途写者）；⑤ 静默期间 `flushChapterBeforeLeave` 一律不写盘（`:226`），直到权威重读落定才解锁（`:337`/`:345`）；⑥ 采纳抛错走 `writeGate.abort`（`writing-workspace.tsx:180`，实现 `preview-panel.tsx:450-463`）：恢复编辑区、把未落盘正文重新排队；⑦ 令牌在 accept **落盘之后**递增（`writing-workspace.tsx:185`），**不再**在 `onAdopted` 递增——回填可能跑很久，那之后用户已继续写作，再刷新会冲掉新内容。 |
| evidence_ref | `preview-panel.tsx:59-78/91-95/122-126/226/259-300/333-350/389-410/432-474`；`writing-workspace.tsx:150/152/164-190/491-493/528-530`；缺陷成因 `preview-panel.tsx` 装载 effect 仅依赖 `selectedFile` + 旧 `onAdopted` 只 `setSelectedFile(同路径)`；同路径复用 `src/lib/novel/draft-manager.ts:105-121`（同 stem 直接返回选中路径）；采纳读旧写新的事实依据 `src/lib/novel/draft-manager.ts:180-196`（先读既有前缀再写、写后读回校验）与 `src-tauri/src/commands/fs.rs:385-432,502-507`（独立 `spawn_blocking` + temp/fsync/rename，无写者间 CAS/次序保证） |
| 不变式依据 | 令牌不变 ⇒ 装载 effect 不额外读盘（`:361` deps 只在 token 变化时改变），`dataVersion` 抖动与普通 rerender 不打扰未保存文本；令牌指认的文件不等于当前选中文件 ⇒ effect 直接早退（`:272-278`），采纳期间已切章不重载新章；只有 `writeGate.begin` 命中同一路径才置 `adoptionLockRef`（`:442-443`），异路径采纳完全走既有切章/保存路径 |

## 二、当前覆盖与已证残余（最终独立源码复核：request_changes）

| 边界（root 合并口径） | 处置 | 证据 |
|---|---|---|
| F1-R1 刷新窗口内接受输入后被静默丢弃 | **覆盖**：采纳刷新分支复用既有装载守卫（`loadedFilePath !== selectedFile` → 只渲染加载态，`:1410`），旧编辑器整体卸载 ⇒ 窗口内不存在可输入缓冲区，不存在「补一笔被丢弃」这条实现取舍（原用例已改为断言这一点） | `preview-panel.tsx:280-289/1410`；`preview-panel.spec.tsx`「采纳重载窗口内旧缓冲区已卸载」 |
| F1-R2 旧的等待放在 accept 之后，不构成写序 | **部分覆盖，仍阻断源码接受**：顺序已改为 begin→accept→token；但 `saveWriteRef` 单槽只保留最后派发的一笔。两笔在途时后笔先完成即可放行，前笔随后覆盖采纳正文，不能再称「所有在途写盘都等过」 | `writing-workspace.tsx:169-185`；`preview-panel.tsx:389-410/432-447`；复核 R1-F1，既有用例仅覆盖单笔 Promise |
| F1-R3 同接口其它写者（flush / format / save-as-final / 标题提交 / 去AI味回填） | **撤回「源证排除（可达性）」并保留阻断**：加载守卫阻止未来入口，不约束 begin 前已启动的异步操作。标题同步、排版、保存为终稿未登记到门；终稿评审 await 后仍可用旧 `fileContent` 闭包覆写采纳正文。已测锁内 flush 早退与另一条去AI味草稿路径的排除仍有效，不推广为全部写者安全 | `preview-panel.tsx:189-240/672-694/702-816/889-903`；Dock `disabled={busy}` 仅自身状态，`chapter-draft-dock.tsx:287-302`；复核 R1-F2 |
| 读失败不得把空/错误/旧正文写回正式章 | **仅已测边界通过**：错误如实上报、失败用例 1.2s 内零写盘；但 then/catch 先解锁、`fileContentRef` 等 passive effect 才同步，瞬时生命周期 flush 仍可见旧缓冲；不声称所有失败/生命周期交错安全 | `preview-panel.tsx:185-187/333-350/359-386`；复核 R1-F3 |
| 取消/切章终止清锁 | **已证残余，与上述同任务合并**：cancelled/选章守卫能在清锁之前早退，导致该路径 flush 持续被抑制。组件卸载不会自行销毁 JS timer，撤回笼统「卸载必丢 timer」口径；真实关闭窗口时序未复测 | `preview-panel.tsx:226-231/270-278/334-356`；复核 R1-F4（主控限定义） |
| 采纳抛错 / abort 的证据口径 | **非独立阻断，但需纠正**：正式章先写、再读回核验，throw 不证明零前序 I/O；mock 的失败恢复只证明桩行为，不证明真实缝完全未落盘。失败如实呈现，不要求本件重造 accept 回滚/状态权威 | `draft-manager.ts:186-194`；`writing-workspace.tsx:175-181`；复核 R1-F5 |

## 三、三条既有邻近模式（复用而非新造）

| 模式 | 既有证据（file:line） | 本次如何沿用 |
|------|----------------------|--------------|
| 刷新计数器（token/deps 增量） | `writing-workspace.tsx:146/152`（`draftReloadKey` 拼进 `usePendingDraftCount` 的 reload key）；`chapter-draft-dock.tsx:121`（`reloadKey` 驱动草稿列表重读） | 同样的单调 +1 计数器，作用域收窄到「采纳」这一件事，只做 `PreviewPanel` 的额外 deps |
| 读盘取消 / 迟到结果丢弃 | `preview-panel.tsx:260`（`let cancelled = false`）+ `:335/344`（`cancelled \|\| getState().selectedFile !== selectedFile` 双重护栏）+ cleanup | 保持原护栏；采纳重载仍先判 `cancelled` 再落地，迟到旧读不覆盖新正文 |
| 安全保存时序（防抖/已加载快照/早退） | `preview-panel.tsx:221-240`（先清 timer，再 `markdown === lastLoadedRef` 早退）；`scheduleSave`（`:389`，1s 防抖 + 写成功后把自身写盘当作新的「已加载」）；`handleSaveAsFinal` 写前清 timer | 采纳窗口沿用「清 timer 而不是 flush」，并把「旧的等待」从读盘前挪到**采纳写入前**；`abort` 复用的就是 `scheduleSave` 同一套写盘/回执语义 |

## 四、本地实测证据（原始 stdout 见 `logs/`）

| 阶段 | 命令 | 退出码 | 结果 | 日志 |
|------|------|--------|------|------|
| 超集 **RED**（旧候选口径：把三处安全边界逐一摘掉后重跑新用例） | `npx vitest run src/components/layout/preview-panel.spec.tsx -t "G2-NATIVE-F1"` | **1** | 11 例中 4 例失败，正好对应四条新增边界：① 采纳前排队的旧缓冲越过采纳写回（`writeFileAtomic` 被调用）；② 重载窗口内旧编辑器仍挂载（`editor-content` 仍存在）；③ `begin` 未等在途写盘落定（`beginSettled` 立即为 true，断言 `expected true to be false`）；④ 窗口内 pagehide/切章仍把旧缓冲写回 | `logs/red-amendment-g2-block.log` |
| 聚焦 **GREEN** | 同上 | 0 | 11/11 passed（161 deselected by -t） | `logs/green-amendment-g2-block.log` |
| 受影响 spec 文件全量（2 文件） | `npx vitest run src/components/layout/{preview-panel,writing-workspace}.spec.tsx` | 0 | 2 files / **216 passed**（`preview-panel` 172 例 + `writing-workspace` 44 例，含既有 flush/切章/保存/空态/错误态原样通过） | `logs/green-amendment-affected-2files.log` |
| **强制全量** typecheck | `npm run typecheck`（= `tsc --build --force --pretty`） | 0 | 无 diagnostics | `logs/typecheck-amendment-force.log` |
| 定向 eslint（仅 4 个改动文件） | `npx eslint src/components/layout/{preview-panel,writing-workspace}{,.spec}.tsx` | 0 | 无输出（config 仅启用 boundaries 依赖方向门禁） | `logs/eslint-amendment-changed-files.log` |

- RED 的构造方式：**不重跑旧候选源码**（旧候选已被本轮 amend 覆盖），而是把本轮新增的三处安全边界（flush 静默 / 装载守卫 + 防抖作废 / `begin` 等待在途写盘）逐条摘掉后跑同一批用例，得到 4 例失败；恢复后 sha256 与 amend 版逐字一致（`8898bf3e…`），随后 GREEN。**该 RED 只说明「这些用例真的在测这三条边界」，不构成旧候选源码的历史失败证据**（旧候选的历史 RED 见 `logs/red-preview-panel.log`）。
- 未跑且**复用既有证据**（不受本轮 invalidator 影响，文件与接口均未改）：`chapter-draft-dock.spec.tsx`（C3-0「第一步只展开确认面板，不写盘、不 ingest」、四态呈现）与 `debug-title.spec.tsx` —— 依据 `logs/green-attempt3-affected-files.log`（4 files / 234 passed，旧 token 候选口径）。
- **旧包证据不可迁移**：`logs/typecheck-force-final.log` 与 234 passed 只覆盖旧 token 候选；本轮源码/用例已变，故只以本表新日志为准。
- 执行者未跑：全仓测试矩阵、cargo、e2e、build、生成物；主控随后只补了确已失效的 atlas 生成/字节单目标检查（第九节），未重跑其它通过结果。

## 五、累积尝试台账（跨共享采纳/编辑区接口）

| 项 | 计数 | 说明 |
|---|---|---|
| 之前源码迭代 | 2 | 旧候选 attempt1（令牌/早退/在途写盘）、attempt2（读盘窗口二次清 timer） |
| 执行者报告的聚焦测试修正失败 | 0 | 这是机械口径，不是端到端源码语义收敛；原候选与 amend 均有被确认的安全缺口 |
| 保留的 spec 语法失败 | 1 | `logs/green-attempt2-focused-block.log`（保留，未计入失败修正） |
| 本轮合并修订 | 1 | 本轮唯一一次生命周期合并修订 |
| 本轮「测试先失败」的修正次数 | 0 | 聚焦用例首跑即 GREEN；RED 为主动摘除边界的对照实验 |
| 本轮自审细化 | 2 | 首跑 GREEN 后自查发现两处不精确，在**任何测试失败之前**就地收紧：① 跨平台路径比较改用 `normalizePath`，未落盘判定改为按**原样**正文比对（避开归一化差异造成的多余写盘）；② `abort` 回填 `loadedFilePath` 时改用当前选中值（否则加载守卫的严格相等会卡在加载态）。未新增失败目标，细化后所有记录在案的 green/typecheck/eslint 日志已重跑对齐（源文件 mtime 07:36:19 早于 07:36:24/07:37:09/07:37:53 的三次运行） |
| 最终候选未通过语义接受 | **2** | 原候选由主控确认读窗丢输入/错误写序；amend 被唯一独立复核判 request_changes |
| 同共享接口未收敛审查 | **3（保守计数）** | 原生 F1 发现 → 主控合并边界 → 独立源码复核新 material 边界；停止自动修正/复核链，机械失败 0 不清零历史、不授权第四轮 |

## 六、未覆盖 / 诚实残余（不再作为「债」挂账的部分已在上表覆盖）

| 残余 | 为什么留在这里 | 偿还触发 |
|---|---|---|
| 跨进程/外部写者的写序 | 本件只在**编辑区**这一侧做前置静默；`fs.rs` 仍是独立 `spawn_blocking` + temp/fsync/rename，没有写者间 CAS。若同一章被**另一个**进程/窗口并发写入，本件不仲裁 | 出现「非编辑区写者覆盖采纳正文」的可复现证据，或采纳链需要跨进程写序令牌 |
| 真实 Tauri 应用的端到端时序 | 无 native/app 额度，未在真实应用里观察「采纳 → 编辑区刷新」与真实键入节奏的交叉 | 下一次有 native 额度的点验 |
| 采纳写入期间切走后再失败 | `abort` 会把未落盘正文按**原路径**重新排队保存（不静默丢稿）；此时用户已在别的章上，那条写盘不呈现于当前编辑区 | 需要「后台保存」可见反馈时 |
| module-atlas 生成物（主控机械补证已闭合） | 执行者未运行、未编辑；主控随后用既有生成器只重生成 atlas，临时路径重生成后逐字节一致，见第九节。仅两个组件的行数与总行数变化，图与 schema 不变 | 不再重跑该未失效结果；源码若再改统计输入则重新对齐。此补证不代替源码独立复核 |

## 七、观测 vs 推断边界（机械 ≠ 语义）

1. **已观测（仅用例覆盖内的机械证据）**：变异式摘除后 4 例失败、恢复后 11/11 通过；单笔在途写盘会被 begin 等待，锁内重载旧编辑器卸载，已测 pagehide/切章零写盘、mock abort 恢复、读失败零写盘；两文件 216 例全绿、强制 typecheck 0、定向 eslint 0。**不能推广为全部在途写者或所有生命周期交错安全**；源码复核已证明第二区域的反例。
2. **属推断（未观测）**：真实 Tauri 应用内「采纳 → 编辑区刷新」的端到端观感、`write_file_atomic` IPC 与真实用户键入节奏的交叉；两条组件用例（`preview-panel` 的 gate 语义 / `writing-workspace` 的调用顺序）通过同一个 `PreviewPanelWriteGate` 接口类型拼接，**没有**单条用例跨越两个组件。
3. **未接受 / 未宣称**：字面 G2 仍在安装态 f36 的既有范围成立，不等于全入口/整UI；本源码候选的唯一独立复核已经 request_changes（第十节），不宣称语义闭合或产品有效性。当前源码打包/完整安装/whole Goal 均未由本件满足。
4. **机械接受 vs 独立语义接受**：本文件全部 GREEN 都是「mock 组件测试 + 强制类型检查 + 定向 lint」级别的机械证据，属于**机械接受条件**；**独立语义接受**由那一次新授权的全新源码复核给出，本件不自我裁决。

## 八、边界声明（防止误读）

1. **未改动面**：未改 `chapter-draft-dock.tsx`（Dock 注入点签名与「第一步只展开/第二步才写」顺序不变）、未改 `draft-manager.ts`/accept 链、未改 `wiki-store`（无新 store/state 权威）、未改 `chapter-save-strategy.ts`、未加 `dataVersion` 监听、未做 remount/`selectedFile=null` 技巧、未加依赖、未改 i18n、未改样式与既有 affordance、未改 Rust 侧写盘层。
2. **既有测试面**：`preview-panel.spec.tsx` 的 G2 用例由 6 例改为 11 例（新增「令牌指认别的文件」「在途旧写盘写序」「abort 恢复」「pagehide/切章静默」「读失败零写盘」；原「窗口内补一笔被丢弃」用例改为断言旧编辑器已卸载）；`writing-workspace.spec.tsx` 新增/改写 4 例（两个挂载点令牌 + 写序 + 失败回执）。未删改其它既有断言、未降级任何断言、未加 `it.skip`/`only`/重试/放宽超时/`any`/`@ts-ignore`/空 catch（唯一新增的 catch 形分支是用例里把采纳错误交给 spy 观察，非空吞）。
3. **生成物 invalidator（具体，不做「大概没有」的假设）**：`src/lib/novel/module-atlas.generated.json` 按 `code.split("\n").length` 记录每个模块的 `l`（对以换行结尾的文件 = `wc -l` + 1）。本轮同口径实测：`src/components/layout/preview-panel.tsx` **1567**（`wc -l` 1566）、`writing-workspace.tsx` **564**（`wc -l` 563）；amend交付时 atlas 仍为 `1429` / `537`，主控随后已依既有生成器单写者重生成并单目标字节PASS（第九节）。执行者未编辑生成物，未重跑 `gen:check` 全6目标。新增公开面 `PreviewPanelWriteGate` / `PreviewPanelWriteGateSnapshot` 与两个新 optional prop 只影响该文件导出面，atlas 只统计 import 图/可达性/行数，未见导出面字段；`writing-workspace.tsx` 未新增外部依赖包。
4. **流程偏差（如实保留，不粉饰）**：本轮之前的那次源码执行里发生了 **1 次未授权的创作侧真实模型作业**（`maestro explore`，自述主模型 deepseek-v4.1-flash）。它属于编排/检索侧越权，**不是**产品运行时推理，也**未**被用作任何验收证据；本件的产品运行时推理调用数仍为 0，但不能表述为「全程没有任何真实 LLM 调用」。本轮未再发生任何 `maestro explore`/delegate/moa/嵌套模型作业，也未启动应用、未连 MCP/CDP、未打真实书稿或正式记忆、未执行安装/发布脚本。
5. **不代替独立复核**：status 已据唯一复核更新为 `Request changes`，未 commit/push。不得按复核末段的「下一修正版仅机械+残余即可接受」建议越过确切源码独立语义验收；该建议不是真人授权。

## 九、主控生成物机械补证（仍非源码语义接受）

- `2026-11-13T22:55:30.248Z`，主控单一写者执行既有 `scripts/gen-module-atlas.mjs`，随后以同一生成器 `--out` 写入自有临时路径并与仓内产物逐字节比较；两次生成器 exit 0，单目标校验 PASS。
- 产物仍为 248902 B，sha256 从 `a7e426a40c6a56f5decdf7b980fdbfda61704bb74908bdd57659cb24790ae81f` 变为 `52813151c78c20f9769f8a6f2dd35c7566891b13f2fe1eb247d56b057af29e63`；仅 `preview-panel.tsx` 的 `l:1429→1567`、`writing-workspace.tsx` 的 `l:537→564` 与 `stats.loc:290822→290987` 变化。模块数 1193、边数 4657、可达性、其它数据与 schema 均逐字段一致。
- 四个源码/spec 文件生成前后 sha256 一致。未重跑 216 个组件测试、强制 types 或其余五个生成物校验：本次只改 atlas 的数字行数元数据，不改变图/schema/type shape 或 UI 用例依赖的值；仍有效证据继续复用。不伪称重新取得 `gen:check 6/6`。
- 原始命令输出与断言回执：本 Run `work/g2-editor-refresh-20261113/{logs/atlas-root-verification.log,atlas-root-verification.json}`；生成前产物保留于 `atlas-before.generated.json`。
- 本节仅关闭生成物漂移，不宣称修复已经独立语义接受、已提交、已进入实际安装包或 whole Goal 已满足。

## 十、唯一独立源码复核与主控裁定

- 任务关联号 `036b27e5-ce96-4b4e-902c-4730cc734c2a`，不可变结果 `agent://87fb8136-1307-46c0-9b41-1b37e1c35514` 已完整消费（charOffset 0/2000/4000/6000/8000，末页完整）；结论 **request_changes（仅本 F1 源码腿）**，6 个声明条目均有覆盖。
- 同路径刷新、两挂载点与窄信号源证成立；R1-F1/F2 两条覆写路径由主控对当前源码确认；R1-F3/F4 生命周期残余并入同一问题，F5 修正文案/桩证据口径，F6 无超时仅观察，不新增硬门。主控同时纠正复核的旧 `draft-manager.ts:210-216` 引用为当前 `:186-194`，并限定 F4 的 timer 卸载推断。
- **不继续第四轮自动修正/复核**：保留候选与全部日志。唯一新源码复核已消耗 1/1；下一步需要掌舵人指导重设计与有效独立语义验收权限，不能将旧次数清零、改任务名、由执行者/主控终审或只凭机械绿色关账。
- 最小方向是现有组件内统一自有写入协议，覆盖全部在途操作及 await 后恢复路径、ref 同步与所有终止清理，而非逐个回调补锁；这只是供裁决的方向，**未实施、未批准**，不引入新 store/Node gateway/accept 状态权威。
- 主控裁定与源证映射：本 Run `work/g2-editor-refresh-20261113/root-source-review-disposition.json`。字面 G2 在已安装 f36 范围仍通过；现有包/签名/安装证据相对新源码为历史，未重新对齐。整 Goal 仍缺包级 MCP、完整当前源码安装/自动更新与锁定 162 章 L9/P0/T09；8 份 PREACCEPT 和三条伏笔保留。

## 十一、真人只读重设计请求与提案交付（非源码接受）

- 真人选择「先出只读重设计方案」，不是实施/追加复核许可。单个 fresh planner 产出不可变结果 `agent://e1b18179-91cc-4359-b38c-320c6f7e1849`，全文已消费；无写文件工具，未绕过限制，交由主控保存。
- 主控只读整理到本 Run `work/g2-editor-redesign-after-source-review/readonly-proposal.md`。明确区分 await前意图与实际I/O准入、真实FIFO前驱、不可取消的已开始写盘、canonical受影响路径组，以及所有终止路径的归属清理；修正规划稿0调用/长评审入等待链等不充分口径，不给代码/方案独立approve verdict。
- 既有 `preview-panel-helpers.ts` 符合CLAUDE纯逻辑分层，但属于需批准的源码域扩展；未存正文/标题不得以丢弃或仅错误提示代替恢复。恢复策略、域、方案、未来实现和新的独立语义验收权限仍待掌舵人裁决。
- 本阶段只写提案/执行记录/本节追溯，无源码或生成物变更、无测试重跑/产品资源调用。sourceReview仍request_changes、1/1已耗，原16项记录一致性PASS和现有机械日志复用；无commit/push、verify-goal或Goal完成请求。

## 十二、r6 真人新设计权限、执行中断与主控机械恢复（仍待独立语义接受）

前十一节保留旧候选与旧授权的历史，不作为本节统一协议候选的当前源码说明。此次不是重启旧自动修正链；实际批准稿为 r6，checksum `769e245298e4e2b9c587334c356d76d5e7c4a7827b54131efc013b439c682aa0`，handoff `f236898b97b33d2d2c4f17fe1755e66a2fc955e27745d2b80d81dc9d601afe64`。

- 批准范围新增既有 `preview-panel-helpers.ts`，允许一个统一协议工作项、相关机械检查、必要 atlas、新的一次独立源码语义复核及条件满足后的 P16 本地分离提交；明确不授权 push、发布/版本/CHANGELOG、CI、MCP/native/安装/书稿资源。旧两位执行者、旧复核 1/1 与旧三次保守未收敛记录不清零。
- 最初 Plan 发布到新 Session 的绑定失败并未修好或伪改。真人随后明确选择「现有Session当前执行」，保持现有 `20261109-ralph-expert-residuals`、完整 Goal 与同一 r6 范围/额度；原 G5 Run 仍 blocked rev2/orch39，无竞争 Goal/Todo、新 Workflow 或 verify-goal。
- 唯一新 fresh 执行者 `41af2edf-d928-4c04-9bcc-a8efebbc00fa` 已修改 helpers、两个视图与两个既有 spec。其最后模型响应在 `message_end` 因 `503 no_healthy_account` 中断；不可变结果 `agent://09c322ac-928a-41b2-914e-57f32afdea1e` 仅含「Now fix the three failing tests:」，不是完成报告或授权主控继续修正。最终 `unified-implementation.json` 未生成。主控不重新派发、不写产品源码，仅恢复原始日志和既有许可内机械检查；以下记录为主控事实追溯，不冒充执行者正式交付。

| 本 r6 阶段证据 | 已观测结果 | 原始日志（本 Run `work/g2-editor-redesign-after-source-review/logs/`） |
|---|---|---|
| 新 G2 聚焦 | 16 passed / 172 deselected | `unified-focused-panel-g2-cases.log`（14:37:46） |
| 单文件与最终二文件 | preview 188、workspace 45；最终 2 files / **233 passed** | `unified-full-preview-panel-spec.log`、`unified-full-writing-workspace-spec.log`、`green-unified-affected-2files.log`（14:50:35） |
| 三次主动 mutation-RED | fence 去除 3 failed、FIFO 去除 2 failed、refs 后置 1 failed；均在最终 233 GREEN 之前，不能当作最终真实失败 | `red-mutation-1-fence-removed.log`、`red-mutation-2-fifo-removed.log`、`red-mutation-3-refs-after-unlock.log` |
| 更早聚焦失败 | 14:29:36 有 9 failed / 7 passed，其中首例超时后多例空 DOM；保留历史，不迁移为最终失败 | `unified-focused-panel-new-cases.log` |
| 主控补强制 types | `npm run typecheck` = `tsc --build --force --pretty`，pipeline exit 0，无 diagnostics | `root-recovery-typecheck-r6.log` |
| 主控补五文件 eslint | helpers、两个视图、两个 spec；pipeline exit 0，无 diagnostics，无 `--fix` | `root-recovery-eslint-r6.log` |

- 证据复用：五文件变更使旧源码 types/lint 与旧 atlas 输入失效，故只补当前缺少可复用记录的强制 types 与五文件 lint；原始最终 233 GREEN 没有重跑。没有全仓 suite、build、cargo、CI、真实 app/安装/MCP/书稿调用。
- 恢复边界：teammate 历史查找仅扫描前 100 文件、coverage partial、零匹配，不证明完整轨迹不存在，不声称已找到所有中间修正或最终提交状态。三个 mutation-RED 与更早 9 项失败按各自原始日志保留，不以简短捕获文本推断当前还有三个失败。
- 主控开始补追溯前，按执行者 baseline SHA256 校验：五个代码/spec 文件按预期改变；旧 atlas、本 decision-log 与十份 L9 脚本共 12 项一致。命令 exit 1 来自预期五项代码散列变化，不是受保护文件失败。本节随后由主控追加，不能再声称 decision-log 仍与该旧 baseline 相同。
- 新执行者额度已用 **1/1**，新独立复核 **0/1** 未用；源码候选仅达到已恢复的机械条件，**未语义接受、未提交/推送、未进入新实际包**。atlas 待主控单写者维护；新增 import/协议可能改变图，不能沿用旧第九节「只有 loc」的结论。必要生成后才进行新额度的一次独立源码复核；request_changes 即停线，不再补丁/复核轮。
- 原 G2 字面 DoD 仍在已安装 f36 的历史范围成立；包级 MCP、完整当前源码安装/自动更新、锁定 162 章 L9/P0/T09仍缺，8 份 PREACCEPT 与三条伏笔保留。机械恢复不解除这些门，也不完成整 Goal。

## 十三、r6 生成前范围预检：材料性未落实，按批准稿停线

主控恢复的是机械记录，不是统一工作项或源码语义接受。R-2 在实际生成之前回读真实候选，确认以下四组仍属于同一共享接口、同一合并项的未落实边界；不以新任务名/模型故障清零旧三次保守未收敛记录。这是主控只读源证预检，**不是**新额度的独立复核 verdict。

| 合并源证项 | 当前锚点与确定的边界 | 未落实的 r6 语义 |
|---|---|---|
| R6-PC1：恢复/迟到 UI 结果归属 | `preview-panel.tsx:585-590` 仅登记 recovery；`preview-panel-helpers.ts:390-399` 的 peek/drop 没有生产 UI 消费。`preview-panel.spec.tsx:4014` 只断言 Map 有 buffer，未返回原章检查输入。另 `preview-panel.tsx:813-821` 在标题 await 失败/被拒后无当前路径护栏恢复旧标题，可污染已切换的别章 UI。 | 10/11/12：未存正文/标题须接回现存同目标 UI，不以登记/报错代替恢复，也不灌别章。 |
| R6-PC2：采纳 I/O、FIFO 与 lease 生命周期 | `preview-panel.tsx:538` 已取 lease，`:550-551` 等 tail 后才记本地 ref；等 tail 时卸载的 `:448-464` 清理看不到该 lease。非当前目标 `:540` 直接 idle、不等该目标旧 tail。正式 accept 在 `writing-workspace.tsx:179-185` 也未进入共享 tail；accept 在途时卸载直接释放 lease，不能保证新实例写者仍排在 accept 之后。 | 3/5/9/10：每个实际目标都排序，owner/在途 I/O 不随 UI 卸载丢失；不能只提前记 ref 再无条件解锁。 |
| R6-PC3：快照取得过晚 | `preview-panel.tsx:550-558` 在旧 mutation 落定后才取 buffer；此前 canonical/format 提交会改 ref（`:284-288`、`:1069-1087`）。旧 A 在途→用户新脏 B→begin 清 B timer→A 落定→取得 A 快照→accept 失败，可丢 B；abort 同路径还假定正文未被替换。 | 6/11/12：begin 前保存真正最新未存输入，错误/部分 I/O 不无条件回写旧正文，也不丢稿。 |
| R6-PC4：已确认目标迁移后仍采纳 | `preview-panel.tsx:264-280` 的既有 canonical mutation 可改目标/删旧路径；begin 等完后仍 ready，没有迁移/reconfirm 结果；`writing-workspace.tsx:172-185` 只拒 busy，继续对原参数调 confirmed seam。 | 7/8/10：此前准入迁移改变确认目标须中止并重新确认，普通切章不能粗暴当作迁移。 |

- 以上为可达代码顺序/缺失接线的**源证确认**，未做新 native/I/O 点验或新回归测试。233 passed、强制 types0、五文件 lint0仍照实保留；它们的用例没有完整证明这些边界，不改报成“测试失败”，也不推广成语义闭合。
- 精确候选冻结于本 Run `work/g2-editor-redesign-after-source-review/r6-pre-atlas-source.diff`：5 文件、1775+/102−、110272B、SHA256 `8de18d854a54d4c47a782fd9dd84e7c618bada79260ac8c49835b12379e284ef`。逐文件 SHA 和四组交错详见 `root-r6-pre-atlas-disposition.json`；不回退/丢弃源码或10份 L9 脚本。
- **r6 停线**：R-1 未完成上述硬行为；R-2 未执行，旧 atlas SHA `52813151…29e63` 保留且相对新输入仍失效；R-3 未派发，新的独立复核 **0/1** 保留；R-4 未开始，无 commit/push。主控未写产品源码、未补测试代码、未生成 atlas。
- 新执行者已用 **1/1**，模型 503 与不完整报告都保留。任何继续编码必须由真人显式追加一次执行权限，不是重置旧额度；仅可继续同一 r6 合并项/既有域，不加 shadow 协议、store、依赖或新资源。独立复核仍仅原已批准的新 1 次；request_changes 即停，不再自动补丁/复核。
- 最简等价续作是补齐原已批准的 UI 接回、I/O/lease 归属交接、同步快照与迁移再确认，而不是另出全项目计划或逐回调补锁。整 Goal、原 G5 blocked rev2/orch39、三个外部门、8份PREACCEPT与3条伏笔全部不变。

## 十四、唯一追加 anyrouter 执行者终止：部分效果冻结，源码仍未完成

真人随后明确「追加一次（anyrouter）」：仅新增1执行槽，同一r6域/13条固定语义不变，新的独立复核仍原0/1，不重置旧失败和外部资源额度。原Plan绑定失败及「现有Session当前执行」路由保留；这不是未批准执行，也不是新Plan/Goal/Todo。

- 唯一追加任务 `g2-unified-write-r6-authorized-continuation-anyrouter` / `1cff2868-b764-4145-b2f8-e635d72da7f4` 使用 `anyrouter/gpt-6.1-sol`，在message_end因token-rate-limit（gpt-6.1-sol-2026-09-29 / westus3）终止。自动fallback被side-effect replay fence阻止；`agent://79c61cc6-8450-427e-8646-55a157cbfdd2` 已消费但只有拒绝正文，不是完成报告/源码语义verdict。不得resume、重派或改预算绕过栅栏。
- task-owned目录仅baseline与两份实施前RED日志，没有execution JSON、GREEN或最终types/lint。此前口头“8个RED”未由完整原始回执核验，验收不采用数量；RED不是当前最终失败/通过，不为补数量重读/重跑。
- **实际源增量不为零**：脏文件名单虽然未变，追加baseline后helpers、PreviewPanel和其spec的SHA已变；workspace和其spec未变。此前“无源码变化”的初步推断已撤回。当前五文件diff为2393+/108−、142914B、SHA256 `bb8ba4a72fb890af17e6090d47832aa04661aa554bba8c8d8cc95f2d9900fc21`，冻结在本Run `work/g2-editor-redesign-after-source-review/r6-additional-interrupted-source.diff`；逐文件SHA见同目录 `r6-additional-interrupted-snapshot.json`。第十三节的110272B/8de18d85…仍完整保留，但只属于追加前候选。
- 11保护产品文件（旧atlas＋10L9脚本）及18旧不可变证据全部字节不变；可变协调账由Root更新，不冒充immutable。此快照在本第十四节追加前，decision-log仍31066B/原SHA。保护检查仅为保护PASS，不证明代码/产品语义通过或未知外部效果为零。

| 现有合并项 | 当前源证确认的未完成接线（不是新独立复核/native复现） |
|---|---|
| R6-PC1 | `preview-panel.tsx:278-288` 的restoreRecovery只声明、无生产调用；保留恢复输入仍未接回现存UI。本轮仅确认该恢复消费子边界，不声称重新证明所有旧迟到标题论点。 |
| R6-PC2 | `preview-panel.tsx:581-601` 仍在await后记lease并对异目标提前idle；新helpers runAdoption/lifetime未接 `writing-workspace.tsx:166-191` 的真实confirmed accept，卸载/在途写归属尚未闭合。 |
| R6-PC3 | `preview-panel.tsx:599-632` 快照仍取于旧tail之后，同路径abort仍未恢复snapshot.buffer；canonical提交先改同一ref的边界保留。 |
| R6-PC4 | 新noteRelocation/relocationSinceBegin仅helpers生产定义与内部调用，没有canonical/采纳调用者；`writing-workspace.tsx:171-184` 仍继续原确认路径，没有迁移重新确认分支。 |

三个实际源/测试变化使原整体233、force types0、五文件lint0不能作为当前候选通过；原日志保留，未变目标按实际依赖判断复用，不自动重跑。新helper存在不等于完成生产链；当前无GREEN/report且源证接线未完成，按批准稿停线，不自动补验证或修正。atlas仍52813151…历史版本，对r6输入失效，r6生成器0次。

处置：`work/g2-editor-redesign-after-source-review/root-additional-partial-effect-disposition.json`，三账与report已转为终止/部分效果已记录。R-1未完成；原r6槽1/1＋追加1/1均耗，总r6派发2、含旧两执行者共4；新独立复核0/1不消费，R-2/R-3及条件提交持有。Root只写证据/记录/本追溯，无产品源码、atlas、复核、commit/push或新产品资源调用。第6次observe参数拒绝/noSixth失守仍作为Root偏差保留，观察纠错链已停，不重问已答授权。

字面安装态G2独立接受不重开；当前候选工程验收未获，旧2/5审计仅为当时历史。原三个外部门、完整Goal、blocked2/orch39、8PREACCEPT与3伏笔不变。只有新的显式执行权限及可用模型通道才可继续同一域内的最简接线，不重置计数、另造平行权威或绕未知效果栅栏；此停线不等于Goal完成。

## 十五、真人明确保持源码暂停（Goal141）

只读模型登记检查显示4个Claude通道registered/sessionAvailable/healthy，但没有benchmark推荐，健康登记不保证即时API额度且不构成执行许可。随后live `ask-user-question.answers` 对新执行额度问题明确选择 **「保持源码暂停」**，不是机器建议。Run内 `work/g2-editor-redesign-after-source-review/r6-human-source-pause-20261114.json` 保存原题、显示选项、真人答案和权限效果。

新增执行槽0、模型/路由改变0、新复核额度0；既有原/追加1/1＋1/1、独立复核0/1、旧失败/观察计数、未完成源码与失效atlas均保持。Root仅记录，没有源码/生成/派发/复核/提交或产品资源动作。不得由自动Goal续跑重新询问已答授权、复活旧worker或解除源码暂停。三个外部门仍未获新权限/资源，完整Goal不缩小、不计完成；本决定仅暂停源码，不由模型stop/clear整个Goal。

## 十六、真人总授权及直接续接：为现有合并R-1分配新执行槽（Goal148）

新的真人指令「对于所有的剩余任务，我授予你全权处理权。」及本次直接续接，替代第十五节的源码暂停。Run记录：`work/g2-editor-redesign-after-source-review/full-remaining-authority-20261114.json`。原暂停记录/回执及历史失败保持不可变，不把自动Goal提示当作此授权来源。有界历史API回读因invalid-header失败、filesRead0，无精确历史URI；缺口如实记录，不伪造引用或以零命中否认恢复指令。

主控为下一单件自行分配仅1个新的fresh执行槽，完成现有R6-PC1..PC4的生产接线与定向验证；这个数是主控在总授权下的有界分配，不冒充真人原话中的数值。旧执行者4、原/追加1/1＋1/1、旧失败/收敛计数不清零；旧worker不恢复、side-effect replay fence不绕过、观察纠错链不重开。沿用已明确选择的anyrouter模型，新R6独立复核仍0/1，不新增复核额度；Root仍仅协调/记录/必要生成物，不写产品源码。

本次只读预检确认五源码/spec的SHA逐项匹配第十四节冻结快照，HEAD仍f36f38c8，`git diff --check` exit0；这是输入/空白检查，不是产品GREEN或语义接受。接下来沿现有r6固定13语义串行完成R-1、必要atlas、新独立复核及条件P16本地提交。完整Goal和canonical Run blocked2/orch39不变，MCP私有认证/有效加载、真实当前源码安装更新、锁定162章L9须各自真实达标；总授权不豁免Draft-first、P0、FIX-1、正式accept或锁定评分协议。

## 十七、总授权R-1压缩续接中止：只读保留部分效果，第三次基础设施停线（Goal150）

执行者`20d33324-7bac-44ba-8372-b3bc0922815b`在compaction recovery continuation阶段298978ms未续接，运行时中止该恢复。`agent://08d19ed3-28ad-43d8-b20b-3ed055720485`已全文消费，仅为终止错误，不是执行报告或语义verdict；具体内部停滞原因尚未确立，任务目录无最终execution.json。不再等已终止执行者、不重派或复活旧worker。

Root冻结`work/g2-editor-redesign-after-source-review/full-authority-r1-aborted-snapshot.json`与`full-authority-r1-aborted-source.diff`：HEAD/脏路径集合保持，helpers/PreviewPanel有实际增量，workspace/两spec不变。五源码文件2521+/124−、149945B、SHA`73403933b6414f40363d702a2bf946fe83f3c4f0f5e9878f94daeaa2c7aec663`。**在Root追加本节之前**12保护产品文件、18不可变旧证据及治理输入哈希保持；原diff/快照/授权/派发ack不覆盖。Root快照脚本首次write被压缩阈值推迟，直接续接后重发并仅运行一次，未把推迟当失败或丢弃。

唯一本轮日志为改动前PC3意向RED（exit1、1 failed、195不在名称筛选范围，任务自有envDir/setupFiles/retry配置）。源码此后改变，故它与原233/types0/lint0皆非当前通过，也不是native复现；没有最终GREEN/types/lint，不用配置注释证明未知凭据读取为零。限定原四边界源查：PC1恢复订阅/回页消费者已出现，旧“只有声明”事实不能原封沿用，但恢复不变量未验收；PC2真实confirmed accept仍不进runAdoption寿命，PC3仍在尾链后取快照且同路径abort不恢复正文，PC4登记迁移的生产者已接线而原确认stop/reconfirm消费者仍缺。详见`root-full-authority-r1-partial-effect-disposition.json`，无新增独立复核或新修正门。

r6基础设施中断累计3（503、rate-limit/fence、本次压缩续接中止），原/追加/总授权新槽各1/1，全源码派发5；任务名、恢复及真人总授权均不清零旧计数。按收敛纪律停止替换链，Root直接产品源码执行仍不在现有三权边界内；后续需操作者解决恢复通道或给出具体允许的执行路径，不再追问泛化总授权。现有总授权保留，不倒写成真人重新暂停。必要atlas、新R6独立复核0/1及条件P16提交继续持有，Root本次只做源查/字节快照/结果台账与决策痕迹，没有产品源码、生成物、模型产品推理、native/MCP/安装/发布动作。

本次有界current_session历史回读亦因invalid-header失败（filesRead0、零命中不证明缺失），不扩扫；旧失败沿冻结回执和权限台账保留核实。canonical Run仍blocked2/orch39、Goal active150未完成。字面安装态G2原接受保留；真实MCP认证/有效加载、完整当前源码安装更新与锁定162章L9外部门不豁免，不请求verify-goal或Goal完成。

## 十八、真人Root路径与一次合并收敛已用：六项受影响回归失败，源码再次停线（Goal153）

**权限而非推断。** 真人「允许主控单件执行」＋「批准改变执行路径」允许Root声明S3，仅执行原R-1五文件这一件；仅替代之前Root不得写产品源码的角色限制，不允许Root自裁最终源码语义。真人同时授权真实MCP认证入口/受支持加载及安装更新额度增加，三项原件在 `root-direct-r1-and-resource-authority-152.json`。安装增加未给数字；配置加载1、验收lane1、installer调用1是协调器有界分配，当前均0使用，旧connection1/1、installer1与安全专用reserve1保留。私有凭据未提供，不读/输出credential store或app-state.json，不制造无认证替代入口。

Root按入场计原执行 **1/1**，实现写入原五布局文件。首轮聚焦13项9通过/4失败、exit1，按批准稿先停，原 `first-verification-stop.json`、`first-verification-candidate.diff` 与 `logs/01-focused-r6-pc.log` 保留。真人随后明确选择 **「授权一次收敛修复」**，单独原件 `root-direct-r1/consolidated-correction-authority-153.json`；只合并处理这四项已观察失败，追加 **1/1** 入场即计，原13语义、五文件、旧计数及新R6复核0/1不变。切章/标题归属与canonical路径显示一起修正，Ctrl+S断言对齐既有两全角空格排版，不把原始正文加换行误当持久化契约；不是新增框架或弱化断言。

当前机械证据分别计数，不合并成假GREEN：

- `logs/02-consolidated-r6-pc.log`：PreviewPanel聚焦 **11/11**、exit0、80.30s；199项中的188名称排除不计失败或通过。
- WritingWorkspace聚焦 **3/3复用**：helper、组件与spec三输入哈希未变，其PreviewPanel为既有stub，故无需重跑。原回执仍在 `01-focused-r6-pc.log`。
- `logs/03-affected-remaining-specs.log`：同两spec其余 **233项＝227通过／6失败**、exit1、58.06s。名称排除14项由上两组覆盖；唯一并集 **247项＝241通过／6失败**，不是全仓测试。
- `logs/04-typecheck.log`：`npm run typecheck`＝`tsc --build --force --pretty`、exit0；`logs/05-eslint.log` 五文件、exit0。既有act/Vite/Vitest告警保留，两个GREEN不替代六个失败。

六项失败坐标均属 `QMAI/src/components/layout/preview-panel.spec.tsx`：

| 断言坐标 | 已测边界 | 期望／实际 | 当前处置 |
|---|---|---|---|
| :3470 | 旧在途写盘落定后采纳重载 | 已采纳正式正文／旧恢复dirty正文 | 共同成功重载优先级缺陷 |
| :3505 | 采纳失败abort后显式保存 | 旧editor-save回调写1次／写0次 | 原13语义与入口契约待裁定，不删断言 |
| :3819 | 终稿评审晚返回不覆盖已采纳章 | 已采纳正文／原正文 | 共同成功重载优先级缺陷；其他边界断言不计失效 |
| :3868 | 晚canonical解析不得丢标题输入 | 编号化标题／raw标题 | 与输入保留契约待裁定，不计PASS |
| :3962 | 重载读成功后立即pagehide | 已采纳正文／旧恢复dirty正文 | 共同成功重载优先级缺陷 |
| :3985 | 重载读失败后立即pagehide | 空编辑正文／保留dirty正文 | 与失败保留契约待裁定，未擅作fixture错误 |

原设计用现有协调器lease、等待前输入捕获和恢复UI来避免采纳/保存竞争导致输入丢失；**当前确认的剩余同接口根因**是 `preview-panel.tsx:559-591` 的读盘安装之后仍无条件 `peekRecovery → restoreRecovery`，使已承认为成功的旧refresh-token入口回退到旧恢复正文。上述三个成功重载结果共同复现该优先级边界。另三项入口/标题/失败显示期望须先按批准原文裁定，不把保留输入或零I/O直接当无害，也不为了绿测删除/跳过/放宽。最低等价改进建议是沿现有协调器统一“确认成功才消费旧恢复、失败继续保留”并一件核对六边界，不引入第二套状态或永久别名链；建议本身不是追加执行权限或独立语义verdict。

**再次实质失败即停线已经触发。** 当前候选 `root-direct-r1/consolidated-verification-candidate.diff` 为 **169018B／SHA256 `49907dbb37bfc59eec9de8b9fbb5fbf96d6ff4537a170e070419b688f08d3c8b`**；五源码/spec、原日志、复用证据与旧快照保留于 `consolidated-verification-stop.json`。Root入场 `progress.json` 曾原地更新，已逆替换恢复原2276字符/原哈希，它不再作为最新结果；新状态只指上述write-once停线回执。授权证据当时有界历史定位失败/无精确URI一并保留，不猜URI、不覆盖原件。压缩延期的report编辑按未执行重发，不能当成功，也不算新源码槽。

此后只对齐四live台账及本节：`approval-binding-disposition.json`、`work/g2-editor-refresh-20261113/authority.json`、`outputs/execution.json`、`report.md`。历史字段明确限定原阶段，不否认旧授权/失败，也不使旧Root-no-writing或旧GREEN冒充当前状态。**sourceAccepted=false、R1Complete=false、Root最终语义verdict=null**；旧5源码teammate与3基础设施中断不清零，新teammate0，不重派/复活/轮询。必要atlas仍旧52813151…且失效（本r6生成0），新独立R6复核 **0/1** 未派、条件P16提交持有，源码补丁/复验/生成/commit/push/CI及新产品资源动作均停。

canonical Run仍 **blocked/rev2、orch39**，字面安装态G2原独立接受保留，当前源码候选不能借旧工程/签名/payload证据验收。完整Goal不缩小：私有MCP凭据与真实有效加载、接受当前源码后的实包安装/自动更新、锁定162章L9/P0/T09仍未满足。下一步只有新的具体人控源码/契约决定才能重开编码；自动Goal或压缩续接并非新增授权。未进入verify-goal、未seal、未请求Goal完成。

## 十九、真人剩余任务授权续接同一Root R-1合并件（Goal155，入场）

真人在已明确解释“修复额度与R6独立只读复核不同、当前六项失败仍停线”后，直接答复：**「我授权自行探索并完成剩余任务」**。这不是自动Goal续跑或机器建议。新入场原件为本Run `work/g2-editor-redesign-after-source-review/root-direct-r1/remaining-authority-155.json`；未拿到精确历史entry URI的事实如实记录，不猜URI、不重复已失败invalid-header历史扫描。

本件保留原完整Goal、原五源码/spec域与13条已批准语义，**只新增协调器自限的一个Root合并收敛，入场即计1/1，不伪称真人报了数值**。原Root执行1/1、之前追加收敛1/1、源码teammate5和r6基础设施中断3全部保持。新teammate0，不复活/重派旧worker；原新R6复核仍0/1，不能前移成写代码或由Root最终自裁。三处源码成功重载优先级与三处旧动作/期望一起按原11/12等契约核对；不能改需求、删断言、放宽阈值或靠复核抹去红测。

原 `consolidated-verification-stop.json`/差异/五日志/初始2276字符回执以及停线一致性7/7均留原件：它们是授权155之前的已测事实，不是本件改代码后的通过证据。只复验因实际代码/测试/输入改变而失效的目标，未失效WritingWorkspace等证据复用；稳定源后仅原atlas目标生成/字节校验，再原一次fresh独立语义复核。新实质失败仍保留并停线，独立request_changes不追加复核或补丁。原P16本地条件提交不提前，版本/Release/CI等旧禁令及MCP私有凭据、真实包安装更新、锁定L9/720资源门不重置。

授权入场、运行brief（blocked2/orch39）及当前f36f38c8工作树已核实。三个live JSON调用被硬压缩阈值延迟后按未执行分别重发成功，非额外源码槽或语义失败；其后report与本节同步。本件入场时尚无新增产品源码GREEN、atlas或独立结论；这是本节的历史时间范围，不覆盖下一节新验证结果。

## 二十、同一授权155合并件机械GREEN与单目标atlas（独立复核前）

本件仅在原五文件候选中增量修改 `preview-panel-helpers.ts`、`preview-panel.tsx`、`preview-panel.spec.tsx`，不另派源码worker或增加收敛额度。核心剩余边界仍为成功读回与恢复输入的所有权：实际accept成功只在协调器标记本lease的快照，读回未完成不预先丢正文；成功读安装refs后才消费旧正文，未提交raw标题继续保留。读失败保留正文、标题与原错误待处理回执，释放通知/新挂载不能覆盖成泛化提示；新无UI lease重新接手快照并清旧成功标记，不借前一次成功丢本次失败输入。

三项旧期望按批准的原11/12核对后，在同件中改为直接证明所需行为，而不是删保护：旧markdownUpdated回声仍断言0次写，实际Ctrl+S新意图才断言1次写；被拒canonical意图保留exact raw标题并断言恢复归属；读失败保留dirty正文及原错误，明确lease已释放且pagehide仍0次自动正式写。两个新增真实协调器交错用例进一步证明一次accept实际写1次、失败读/卸载/新挂载保留正文与raw标题、后来成功读只消费旧正文，以及第二次无UI失败采纳不会沿用旧成功标记。最终是否满足原13契约仍由原独立复核裁定，Root不作语义终审。

| 新原始日志 | 已执行结果 |
|---|---|
| `root-direct-r1/logs/06-authority155-r6-pc.log` | 两spec定向16通过／233名称排除，exit0 |
| `root-direct-r1/logs/07-authority155-remaining-specs.log` | 同两spec互斥其余233通过／16名称排除，exit0 |
| 唯一用例并集 | **249/249，0失败**；不属于全仓suite，原14＋新增2定向均计入 |
| `root-direct-r1/logs/08-authority155-typecheck.log` | 既有 `tsc --build --force --pretty`，exit0 |
| `root-direct-r1/logs/09-authority155-eslint.log` | 原五文件，no-cache／无autofix，exit0 |

helpers生命周期输入变化使原WritingWorkspace3项实际上失效，故随两spec定向16重验，不假称未变组件字节就可复用共享输入已变的证据。其它阶段有效结果不重赚，Vite/Vitest配置警告未压制。新五源码/spec差异 **177182B／SHA256 `749617b3f99a5ee50346c5be3ade8400a14cd507ee21e689e0fcc7d282317cda`** 和全部原日志哈希／输入绑定落在 `root-direct-r1/remaining-consolidation155-verification.json`。pre155的6红、169018B差异、五旧日志、原2276字符入场与7/7停线检查均为wx历史原件，不覆盖、不重跑，也不抹去失败。

源码稳定且上述检查通过后，仅既有 `scripts/gen-module-atlas.mjs` 的一个失效目标以fresh `--out`与默认输出生成、逐字节比较。当前产物 **248910B／SHA256 `cbc643f533a9d145eaf7a188ffe6cac10e8e30c17d4b7dd3a4bd45f929b820c6`**：1193模块；三个生产锚点loc与归一源码一致、入口可达，两条真实helper导入边成立。helpers/PV的l与WritingWorkspace的l/i变化，edges4657→4658、loc290987→291892，**不是只变loc**。旧52813151…字节留在独立wx before快照；fresh引用、默认产物与日志10/11均绑定在 `remaining-consolidation155-atlas-verification.json`。没有其它生成目标、固定复验波次或全仓/CI/native/书稿调用，249/types/lint输入未变，原结果复用。

复核准备过程如实披露：Root对OCR preview三次传入空/互斥的commit/range参数，均在命令执行前拒绝；没有OCR结果、reviewable_files清单或独立语义verdict，不能计复核成功或R6额度消耗。该接口停止，不尝试第四次。已由Git确定完整六tracked候选＋本新增决策记录共七路径，10个无关L9脚本明确排除；原fresh只读reviewer按准确diff与项目/本批准稿规则独立逐路径覆盖，作为等价复核路径，不新增审批或复核额度。一次有界current_session核对仍invalid-header/filesRead0，未得到精确entry URI，保留这个证据缺口而不猜或扩扫。

此时原fresh R6额度仍 **0/1**，七路径候选冻结等待复核；**sourceAccepted=false、R1Complete=false、Root最终语义verdict=null**，原P16条件本地提交持有。request_changes或新材料性失败仍停线，不追加源补丁或第二次复核。canonical Run仍blocked2/orch39，MCP私有认证/真实有效加载、完整当前源码安装及真实自动更新、锁定162章L9/720资源仍未满足；完整Goal不缩小，不进入verify-goal或请求完成。

## 二十一、原fresh R6独立approve_scoped（源域接受，不闭完整Goal）

独立fresh `reviewer`／taskType `review` 已完成原一次复核：corr `57ea8b03-13d9-4857-acbf-a9fe0e3b57fd`，immutable出版 `agent://d845a492-9263-4b12-90e7-cfc6fb864c84`。完整结果覆盖七路径 **7/7、0跳过**，逐项核对原13契约、FIFO/affected-path原子组、DOM commit屏障、实际accept seam、读回refs先于release、换章/卸载/无UI继任与commit-marker读后消费；未发现批准源域内材料性缺陷。三旧期望独立判为更强的显式保存/raw标题/dirty正文保护，非删断言取绿。Root仅采纳该独立结论，`remaining-consolidation155-review-outcome.json` 记录 **sourceAccepted=true/R1Complete=true/rootFinalSemanticVerdict=null**，没有执行者自终审、二次复核或新源码修改。

复核先核对六tracked final diff177425B／SHA49a33049…b2b8及全篇untracked本记录的七指纹；接受回执再次核对同一七字节。原249/type/lint/atlas输入不变，均复用，不重跑全仓、固定复验波次或生成器。本文之后仅独立结果/提交治理注记，不改变已批准代码语义，不当成原复核又看过的新代码。

以下四观察保留为 **非阻断**，不为了风险枚举开启第四纠正链：

| 观察 | 证据范围与处理 |
|---|---|
| OB-1 | pre-existing、域外 `chat-panel.tsx:279-284` deep-draft正式采纳未进入本协调器；竞争交错未复现，`evidence-needed`，不宣称「全体正式写者」已围栏，也不据此阻断七路径源接受。后续该域需按真实交错验证/用户决策，不在本件扩域改码。 |
| OB-2 | canonical P→Q的已发出delete失败后恢复归Q，当前仍P时`restoreRecovery`路径护栏不显示该回执；`preview-panel.tsx:344-349/:379/:996-1000` 已静态核对，有console错误及Q恢复原件，保留低级诊断观察，不重写独立判断为新的源硬门。 |
| OB-3 | 未来`runAdoption`caller须release/reload才能终结有listener的成功lease；当前两个调用点已履行，保持明确caller不变量，不添猜测timeout/取消已发I/O。 |
| OB-4 | UI-local少量raw路径比较与现行store格式一致；协调器使用normalizePath，作为样式观察，不做额外抽象。 |

分页用corr URI三次被前置拒绝后已停该地址；精确本地alias明确出版IDd845…，读对应immutable缓存JSON全篇并核对name/role/corr/出版ID及源指纹，未伪称工具短片段为完整结果，也不重开复核。同步execution JSON首次atomic编辑因不精确旧counter字符串整体拒绝，按全部未应用处理，检索准确原文后重发成功；非源失败或新增复核。压缩阈值延期的P16/Plan读取按未执行分别重发完成。

P16仅允许接下来的本地三原子提交：五手写源码/spec、脚本生成atlas独立`chore(gen)`、最后本决策记录。A4当前七文件提交面占用只在提交阶段事前登记；本次查阅A4未见此前R6七文件P1事前行，不补造此前合规。当前index空、HEAD f36f38c8，无active默认precommit hook；无关10个L9脚本不代提交、版本/CHANGELOG不动。第三commit自身SHA在Run-local `remaining-consolidation155-p16-local-commits.json` 记录，避免在本文制造自引用或第四文档commit。

P16前两本地提交已执行：五手写源/spec **`6f4db0d6cc7c531eaa76f209ed057a4c9c13a4f5`**（2962+/150−，commit exit0）→独立脚本生成atlas **`c832e2f3dd6d8ccf93276758e9df0e24ca184b9d`**（唯一生成文件，commit exit0）。两原日志为`root-direct-r1/logs/{12-p16-handwritten-commit.log,13-p16-atlas-commit.log}`；本记录只作紧邻的第三docs提交，其自身SHA/父序/唯一文件范围由Run-local wx回执记录，不在本文循环引用、不另造第四docs commit。提交未改已复核源码或atlas字节，不失效249/type/lint/atlas证据。

源域独立接受及本地提交不能替代真机/已安装新源码/跨进程/域外正式写者/MCP真实认证与pipeline读回/锁定L9。当前安装/Release仍是f36f38c8旧快照，不能声称含本件新代码；发布/版本/资产/CI权限不因本地提交而新增，安装验收额度仍保留待必要发布资源可用。不用本地假更新端点或旧包重装冒充本源码真实安装更新。3外部门与全部旧资源界限、既有FAIL不豁免，canonical Run仍blocked2/orch39，不进verify-goal、不seal、不缩小或请求完成完整Goal。
