# 2026-10-24 控制面第一波（doctor真实化+向量健康卡+gen修复）

- 背景：doctor-panel 硬编码 extras（canon/FTS=false、budget空、缺3形态项）导致半数诊断失真；向量运维只有重建/删旧表，缺手动压缩/对账；gen脚本正则漏裸函数 set_proxy_env 误报死命令。
- 变更：新增 `src/lib/doctor-extras.ts` 只读聚合9项（canon revision>0、loadFtsIndex、status.json current_task、fanfic pending、translation-drafts计数、interactive-graph校验、volumeArc待定用chapter_number占位）；doctor-panel 接入+三个自愈按钮（FTS重建/向量压缩/向量对账，跑后复检）；新增 `vector-health-card.tsx` 挂载 maintenance（chunk总数/旧表残留+立即压缩/对账校验/清理旧版残留）；gen脚本补裸函数解析（attr可选分组+handler裸名lib类），regen 得 116注册/0死命令。
- set_proxy_env：lib.rs 早已注册并在 settings-view 保存时热调用；本次只修文档生成器误报，未动 Rust/前端联动。
- 验证：`npm run typecheck` 0错；新增3 spec（doctor-extras 2 + doctor-panel 2 + vector-card 1 共5用例）通过；dashboard-view.spec 52全绿；全量 vitest 15574 passed / 1 failed——唯一失败是 `p44-real-provider.real-llm.spec.ts`（门控在无 STEP0_REAL_LLM_* 凭据时应 skip，本环境凭据缺失，属外部真机用例，与本波改动文件零交集）。
- 残留：volumeArc 仅用 chapter_number 占位（volumeNumber=1/segment=null），待卷册真源接入；budget 仅映射 current_task 单任务，待预算台账真源接入；第二波（CLI探针+DAG回放）未开工。
- 回归插曲：dashboard-view.spec 单用例曾因挂载读盘噪声消失而误报（3次→1次readFile调用）；根因是旧断言耦合了 doctor 挂载副作用时序，已修正为“卡片稳定后清零+断言不选中文件”，并给 doctor-extras 加了首 tick 并行派发。
