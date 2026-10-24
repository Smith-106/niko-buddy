# 2026-10-24 控制面结案（wave1+wave2 全量证据）

- 第一波 53e1e257：`doctor-extras.ts` 真实聚合9项（canon revision>0、loadFtsIndex、status.json current_task、fanfic pending、translation-drafts 计数、interactive-graph 校验、volumeArc 用 chapter_number 占位）+ doctor-panel 三自愈按钮（FTS重建/向量压缩/向量对账，跑后复检）；`vector-health-card.tsx` 挂 maintenance（chunk总数/旧表残留+立即压缩/对账校验/清理旧版残留）；gen 脚本补裸函数解析，regen **116注册/0死命令**（`--check` PASS）。
- `set_proxy_env`：lib.rs:75 定义 + :283 已注册，settings-view:391 保存时热调用——本波只修了 gen 误报，未动 Rust/前端联动。
- 第二波 bcde95cf + 后续3 fix：`cli-probe-strip.tsx`（并行 invoke 四 detect）挂 LLM 区；`capability-replay-drawer.tsx`（trace.jsonl 最近20条倒序）挂 doctor 面板；补 i18n 3 key 中英（6acc969e）、IPC 对账 B5 动态站点登记（dc74dab1）、pill 拒测 Once→持续拒绝（1d550866）。
- 基线：`npm run typecheck` EXIT 0；target specs 全绿（strip 3 + drawer 2 + doctor 2 + dashboard 52 + provider 49 + ipc 5 + i18n 3 + graph 单跑 94）。
- 全量 vitest：15578 passed / 2 failed——`step0-ab-calibration.real-llm`（头注释“缺 key 则 skip”真机用例，无凭据外部项）+ `graph-view` 收展（单跑 94 全绿，并行抖动，本波零交集未碰 graph）。
- 硬边界：未碰 `src/lib/novel/` 主链、status.json 真源、版本/CHANGELOG/generated 单写者面（regen 同源生成随 feature 走）；A4 占用已结清。
