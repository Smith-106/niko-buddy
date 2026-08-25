# 20260822 — T25 context-engine 三源真并行 + canon 事实块注入 + fromCanonGraph 决策

> 任务：TASK-P3-25 / 蓝图 §6 T25（F-19 / F-13 / A-04.4）
> 交付物：`QMAI/src/lib/novel/context-engine.ts`（buildContextPack 三源 Promise.all + 计时探针 + `loadCanonSourceFacts`/`loadTechniqueBlocks`）+ `temporal-memory.ts` 增 `fromCanonGraph()` + `character-cognition.ts` 增 `CanonCognitionInput`/`fromCanonGraph()`（+3 spec 扩展）
> 验证证据：`npx vitest run context-engine temporal-memory character-cognition` **320/320 绿**；全量 `vitest run`（test:mocks 口径）**9708/9708 绿（2 skipped 为既有）**；`npx tsc --build` **0 错**

## 一、decision-log 条目

| 字段 | 值 |
|------|------|
| date | 2026-08-22 |
| task_id | T25 |
| decision_type | U-xx 定稿（实现层口径定稿） |
| value | 见下方 D1–D6 |
| evidence_ref | `QMAI/src/lib/novel/context-engine.ts`（三源并行段）/ `temporal-memory.ts`（fromCanonGraph）/ `character-cognition.ts`（认知轴视图）/ 上方验证命令输出 |

### D1 三源并行形态 = 单次 Promise.all + timedSource 包装器

- **value**：`buildContextPackUnlocked` 内单次 `Promise.all([timedSource("wiki", loadAll), timedSource("canon", loadCanonSourceFacts), timedSource("technique", loadTechniqueBlocks)])`。wiki=数据源注册器 loadAll（原串行长链），canon=时序事实源，技法=T27b 离线编译渲染（纯同步包一层 async 统一计时口径）。各源 `performance.now()` 差值记入 additive pack 字段 `sourceTimingsMs`（telemetry 计时点）并输出一次 `logger.info("context-pack 三源并行装配计时")` 遥测事件。
- **rationale**：蓝图 T25 行明文「wiki/canon/技法 Promise.all，各源计时探针」。原先 wiki 串行 await 完才走后续装配，canon 折叠又深埋在 buildContextPackFromRawData 内与 aura 并行——canon/技法与 wiki 装载零重叠。上提后三源真并发，失败降级在各源函数内处理（不 reject），主装配永不因新源阻断。

### D2 canon 源启用门 = status.json `canon_migration ≥ dual`（默认仍 fold）

- **value**：`loadCanonSourceFacts(pp, targetChapter)`：①targetChapter≤0 → null（原语义：无章节号不加载数据源）；②读 `loadNovelSessionStatus(pp).canon_migration`——缺省/`"legacy"` → 默认折叠路径 `loadTemporalFactsCached`（TASK-004 原行为逐字保留，含同款 warn 日志）；③`"dual"/"shadow"` → T14 读出口 `queryCanonEdges(pp, { valid_at_chapter, archived: false })` → `temporal-memory.fromCanonGraph(edges)`。
- **rationale**：A-04.4 明文「fromCanonGraph（默认 fold）」；蓝图 §417「精品模式硬前置：canon_migration ≥ dual」是现成的迁移就绪信号，复用 T09 会话状态契约零新增配置面（不动 wiki-store NovelConfig）。canon 路径查询失败降级 null + raw canonRules 兜底（与折叠路径同款语义），绝不阻断装配。

### D3 fromCanonGraph 字段映射 = validAt ?? sourceChapter ?? 0 的保守时态回退

- **value**：`TemporalFact` 映射：validFrom=`validAt ?? sourceChapter ?? 0`（无时态锚点 → 第 0 章起恒真，保守不漏）；validUntil=`invalidAt ?? undefined`（Rust `is_valid_at` 同款半开区间）；subject 经 `resolveCanonicalName` 折叠（别名/NFKC 与 fold 路径一致）；source=`canon-graph:<id>` provenance 标记区分 fold 的 `chapter-N`。archived 边跳过、重复 id 去重、输出按 (validFrom 升序, id 码点升序) 确定性排序（与 IPC 返回顺序解耦，F-13 跨模型逐字节一致地基；id 去重后二元比较器完备且不依赖 locale）。
- **rationale**：VIEW 契约不动——temporal-memory 仍零存储，canon 三表（T11）才是真源；产出直接喂既有消费方（renderTemporalCanonBlock / Track B rerank / auditTemporalFactsStatus）零改动。

### D4 character-cognition.fromCanonGraph = per-POV 结果集聚合，doesNotKnow 恒空

- **value**：输入 `CanonCognitionInput[]`（每 POV 一条：character + 该角色 `getFactsKnownBy` 投影产物 facts），输出 `CharacterCognition[]`。knows 渲染为 `source predicate target（第N章）`（知晓时点 revealedAt ?? validAt ?? sourceChapter 回退链），(知晓时点, id) 双键确定性排序 + 文本去重 + archived 跳过；POV 角色名经 aliasMaps 折叠（与 mergeCognitionFromSnapshot 同语义）；每条 fact 过 `assertNoHandleLeak` 兜底（T14 defense-in-depth 复用，句柄外泄 fail-loud）。doesNotKnow 恒空数组。
- **rationale**：T14 读出口按 POV 查询只给正向已知集，「某角色不知某事」需全量观众矩阵求补，属 T33 五角色编排层职责——本视图不做隐式推断、不伪造负向认知（IC-02 不静默造数）。VIEW only：不写 cognition-state.json，快照折叠路径 mergeCognitionFromSnapshot 完全不变。

### D5 技法源 = compileFromCommittedSnapshot 离线路径，仅 chapter_task_brief 注入面

- **value**：`loadTechniqueBlocks()` 用 T27b runtime 唯一合法入口 `compileFromCommittedSnapshot()`（蓝图 §8 P3「runtime 永不直连 nmem」），渲染 `injectionPoint === "chapter_task_brief"` 的 promptBlocks 为行文本（`【标题】正文`），注入 additive pack 字段 `techniqueBlocks`（空产物不注入 undefined）。protagonist_brief / ending_guard / opening_audit 面不进 ContextPack。
- **rationale**：F-19「上下文装配（含技法块）」+ craft-rule-registry「W12 注入范围从 injectionPoint 继承」；ContextPack 对应章节生成装配面，chapter_task_brief 是唯一匹配 scope。消费方按需读取（deep-chapter-task-brief 后续接线），本任务不改其文件（改动最小化约束）。编译失败降级空文本不阻断。

### D6 buildContextPackFromRawData 改预载消费（D7 防 PAT-G2 孪生 load）

- **value**：签名增第三参 `temporalFactsPreloaded: TemporalFact[] | null`（模块私有函数，唯一调用点同步更新）；函数体内联的 `loadTemporalFactsCached` 加载删除，改为 `Promise.resolve(preloaded)` 直接消费。pack 新增 additive 字段仅 `techniqueBlocks?` 与 `sourceTimingsMs?`，emptyPack/legacy 构造器不注入（undefined），contextPackToPrompt/FIELD_CONFIGS/i18n/UI 全部未动。
- **rationale**：事实加载上提到三源并行段后，若保留内联加载即成 PAT-G2 孪生重复 load（D7 教训）；必选参数消除死分支。VIEW 契约不动由既有字节级 prompt 基线用例守恒（全量 9708 绿佐证）。

## 二、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260822-t25-1 | 工作树基线缺依赖：`fast-diff`（canon-reconcile.ts import，T17 文档声明 devDep）与 eslint.config.js 所需 `typescript-eslint`/`eslint-plugin-boundaries` 均不在 package.json/node_modules——tsc/eslint 在未装 fast-diff 前对任何改动都无法 0 错。本任务已补装 fast-diff@^1.3.0（恢复 T17 声明口径）；eslint 缺包属环境层，未动。 | 依赖声明入正式提交（package.json 随本任务落库）；eslint 包补齐或 config 降级 | P3 收口 |
