# 检索并发去重与 `context.inspect` 异步状态桥回读

| 字段 | 值 |
|------|----|
| date | 2026-11-21 |
| task_id | Session `20261109-ralph-expert-residuals` / Run `run-fe6288c0ce65` |
| decision_type | 外部佐证引用 |
| value | 1) `search.ts` 增加同路径 in-flight Promise 去重与 `wikiCacheEpoch` 失效守卫；2) `context.inspect` 慢路径（`includePack` / `dimension` / `inspectionId`）改走 `context-inspect-start` + 250ms 有界轮询 `context-inspect-poll`，不拉大 `DEFAULT_TIMEOUT`（15s）。 |
| evidence_ref | `outputs/v2280-real-book-context-inspect-diagnosis-20261121.json`、独立只读 Reviewer (`subagent_explore`) `APPROVE`。 |

真机诊断 `C:/QM-BOOK/身体都是租的，你让我修仙？`（1,612 个 wiki `.md` 文件）显示：`buildContextPack` 并发触发多个 `searchWiki` 入口时，`readFileCached` 与 `listWikiFiles` 只缓存已 resolve 结果而未去重在途 Promise，导致 19,310 次并发 `readFile` IPC（约 18.6s），且真实检索网络（embedding / rerank HTTP）可在不加缓冲时超过状态桥 15s 同步超时。

本次最小化修正：
1. `src/lib/search.ts` 引入 `wikiContentInFlight` 与 `wikiTreeInFlight` 复用并发读取，并在 `invalidateWikiSearchCache` 及 `dataVersion` 变更时递增 `wikiCacheEpoch`，防止失效窗口内返回的旧读回写污染缓存；`.finally` 在成功与失败路径均以身份校验清理 in-flight 表项。
2. `src/lib/mcp/state-bridge.ts` 与 `src-tauri/src/mcp_server/tools.rs` 保留 0-pack 快路径直调 `context-inspect`，对需要构建或查找的请求改用 `context-inspect-start` + `context-inspect-poll`（间隔 250ms、有界上限 180s），保持外部 `context.inspect` schema 与返回值、`recheckChapter` 漂移终检及 `StateBridgeState::DEFAULT_TIMEOUT`（15s）不变；前端重载导致 `jobId` 丢失时 `poll` 显式报错。

同类排查：`src/lib/graph-relevance.ts` 已直接缓存图构建 Promise（非文件内容缓存）；`src/lib/novel/fts-index.ts` 为串行直读，无同类在途未去重缓存；`tools.rs` 其余 `bridge_query` 均已走即时读取或既有 `taskId` 异步任务机制。本日志不宣称 `G-NATIVE` 真机重测、`G-SNAPSHOT`、`G-INPUT` 或全书 L9 完成。
