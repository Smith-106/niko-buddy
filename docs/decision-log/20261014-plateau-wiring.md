# 2026-10-14：R24 经验主链接线（平台期结构手术建议）

> 来源：Goal"研究→改进→实盘验证循环"第一轮（Todo #164–#167）。
> 纪律：只改现行锚点、行为零变更（diagnose-structure 仅多一条 onThinking 建议，break 路径不变）。

| 字段 | 值 |
|------|-----|
| date | 2026-10-14 |
| task_id | R24-主链接线（Todo #165） |
| decision_type | U-定稿 |
| value | `deep-chapter-generation.ts` 早退点接线：import 三件套+recommendPostPlateauAction；新增 `collectPlateauStructuralFlags()`（轮唱/引号短句复读家族/静默段）；循环前一次 `loadCharacterStates` 预加载角色名；`plateau-stop.ts` 加 `SlopHistoryTracker.getHistory()`；diagnose-structure 分支输出结构手术建议后照常 break |
| evidence_ref | `npm run typecheck` 0 错误；plateau/slop/diff-model/route-shell 四 spec 85/85 绿；实盘 R23vsR24：复读 7→2、轮唱 49 段 6→5、静默 0.19→0.10 |

## 债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261014-03 | diagnose-structure 首轮仅建议不断言改稿（保守上线）；复读家族词源=引号短句高频项为启发式，未接 `rollupStyleStats.topPatterns` 全书信号 | 下一轮实盘出现平台期且建议命中人工复核确认有效后，升级为改稿指令供给 | 下次平台期实盘 |
| DEBT-20261014-01 | （沿用）三件套阈值未标定 | 真实多章语料误报/漏报率 | P2 标定收口前 |
