# 2026-10-24 控制面第二波（CLI四探针条+DAG回放抽屉）

- 背景：claude/codex/antigravity detect 以分散 pill 散在各 provider 卡，cursor 走代理，无统一四连状态；`readCapabilityTraces` API+spec 齐了但零 UI 消费，回放入口缺失。
- 变更：新增 `cli-probe-strip.tsx`（并行 invoke 四 detect，ok/err/loading 四格+重检，失败只显示不阻断），挂载 `llm-provider-section.tsx` CustomProviderCards 下方；新增 `capability-replay-drawer.tsx`（只读读 trace.jsonl 最近20条倒序，intent/mode/outcome/planned 链，读失败空态不阻断），挂载 `doctor-panel.tsx` 自愈按钮下方。
- 约束：纯加法，未碰 `src/lib/novel/` 主链、status.json 真源、版本/CHANGELOG/generated 单写者面。
- 验证：`npm run typecheck` 0错；4文件59用例绿（含 strip 3 + drawer 2 + doctor 2 + dashboard 52）。
