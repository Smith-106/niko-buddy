# cognition 章前读取

| 字段 | 值 |
|------|----|
| date | 2026-11-19 |
| task_id | Session 20261109-ralph-expert-residuals / Run run-fe6288c0ce65 / cognition C1-C6 |
| decision_type | 统计口径 |
| value | 按已签设计：明确目标 N 时只重放整数 0 < chapter < N 的正章 snapshot；cognition 排除 outline 与 isHistorical=true，缺 sourceType 的 legacy 正章仍兼容。undefined 章号保留原 live load/render/error 语义。 |
| evidence_ref | Run outputs/cognition-context-boundary-plan.json，SHA256 1b0d64274edbb57d371d1dbe5cbc83124c6df10b5a9c6e750e988f6331e7c623；原独立准入及 native recovery 准入；work/cognition-context-20261119/native-red-command.json、native-green-r2-command.json |

原原因是 cognitionTextDataSource 未消费 chapterNumber，直接渲染没有逐事实生效章号的最新 cognition-state.json。reader 放在已有 context-derived-stores.ts，复用 foldBeforeChapter 与 PROJECTION_REGISTRY.cognition.foldFromSnapshot；ctx.now=""，每个 snapshot 自建 alias map，保留生产 loader 的按章唯一与升序。不调用 registry load/save、rebuild、drift、自愈、Canon 或 LLM。

真实 RED 在未改 source 时返回“林砚知道：门锁密码”，尽管第 1 章 snapshot 记录“不知道”。同一 datasource 的 C1 在实施后通过。新 spec 使用内存 FS、真实 history/registry/fold/renderer，并断言读取无持久化或 LLM 副作用。

loader 返回 null 是 missing/empty 的缺数据信号，不能截断有效 prior replay。文件中的 JSON literal null 是不同输入：现有 AtomicJsonStore 在读取 fileVersion 时抛错，仍记一次 datasource_error。首轮 255 项回归中的 2 项失败来自把这两个输入混同的 fixture；原日志与原 spec 已保留。修正 loader-null fixture，并新增 literal-null 错误用例后，5 个指定 spec 共 257 项通过，其中新 cognition temporal spec 为 69 项。未修改 AtomicJsonStore。

时序路径仅校验 cognition 核心形状；live 的 lastUpdatedChapter 晚于 N 是正常聚合，fold 的 lastUpdatedChapter 必须小于 N。缺覆盖仍保留可支持的 prior facts 并报 temporal_history_unavailable；缺 fold 或空 replay 且 live 有事实时不注入 live 或猜测 seed。malformed live/fold 记录一次 datasource_error。非法 target 在 IO 前退出。

npm run typecheck:force 与限定 4 个文件的 npx eslint 均 exit 0。diff、保护文件与最终 source SHA 以 Run outputs/cognition-context-boundary-execution.json 及对应 native 收据为准。

本次 native Executor 只占用单次源码恢复额度，历史外部额度不清零，内部 host 请求数未知；语义终审由另一个 fresh Reviewer 完成。Root 后续负责原生成/build/lint/mock 门。当前 snapshot 规范化不等于其内容已认证对应 accepted 正文；manual/seed 的历史生效时点、既有 knows → doesNotKnow 分支与 regex 抽取能力仍待另案处理。本次不修改这些语义。

完整 162 章、P0/书稿验收、真实采纳与记忆回填、Windows 安装更新包仍未完成；该日志不关闭 Run 或 Goal。
