
# DEBT-20260822-a4-01 — A4 归一化重构已知缺口

| ID | 内容 | 行动 | 时机 |
|----|------|------|------|
| DEBT-20260822-a4-01a | normalizeSourceText 无直接 spec：NFKC 全角数字→半角与同形字映射冗余交互、软连字符剥离、幂等性零测试覆盖 | 新建 normalize-source-text.spec.ts 补齐四类用例 | 下一测试波 |
| DEBT-20260822-a4-01b | detectCharacterActions(mechanical-slop-detector.ts:535) 仍走 normalizeText——模块内 slopScore(NFKC) 与行为检测(非NFKC) 双路径不一致 | 收敛至 normalizeSourceText 或书面论证行为检测无需 NFKC | 同上 |
| DEBT-20260822-a4-01c | NFKC 将全角标点(：；！？)转 ASCII，与 normalize-source-text.ts 头部「勿引入中文标点→英文归一」警示矛盾 | 文档对齐：明确 NFKC 标点转换仅限检测视图副本、不回写正文存储 | 同上 |

背景：并发 pi 会话产出 A4 改造后停止活动(>70min)；经三模型共识评审(flash 429 未成票/ox-alpha-free→pro INCOMPLETE 七项风险/hy3 部分事实)由本会话验证后代提交。功能绿(tsc 0/vitest 38)，缺口以债务登记跟踪。

## 偿还记录 (A4 三笔缺口结清)

| ID | 处置 | 证据 |
|----|------|------|
| DEBT-20260822-a4-01a | 已新建 `src/lib/novel/normalize-source-text.spec.ts`，覆盖四类用例：①NFKC 全角数字→半角与同形字映射冗余交互（NFKC 先转半角→后续映射不再命中但结果一致，跨路径文本相等）②软连字符 U+00AD 剥离（仅 `normalizeSourceText` 含该步，`normalizeText` 不剥离）③幂等性（已归一文本再调用结果不变且计数归零）④边界（空串/纯ASCII/纯CJK/混合，含全角标点+数字+西里尔混合） | `npx vitest run normalize-source-text` 全绿（含 mechanical-slop-detector / shared-text-features 共 53 用例通过） |
| DEBT-20260822-a4-01b | 已收敛：`detectCharacterActions`(mechanical-slop-detector.ts) `normalizeText`→`normalizeSourceText`，与 `slopScore` 同一 A4 检测视图归一口径；**未触发回退/豁免**——对 `detectCharacterActions` 既有 spec 对比前后行为，NFKC 仅将全角标点(：；，。！？)转半角，角色名/动作正则均为常见 CJK、NFKC 无操作，归因窗口按字符名(非标点)最近匹配，行为零变化。故无需书面论证豁免，收敛保留。 | `npx vitest run mechanical-slop-detector` P0 角色-动作关联检测全部用例通过，test count 不变 |
| DEBT-20260822-a4-01c | 已对齐：`normalize-source-text.ts` 头部注释明确 NFKC 全角标点→ASCII **仅发生在检测/索引视图只读副本**，由返回值仅交给 slopScore / detectCharacterActions 等检测器匹配，**绝不回写正文存储**(chapter body / 正式记忆)；与「勿引入中文标点→英文归一(毁文风)」警示不矛盾——警示禁止的是把归一后半角标点落盘，检测视图副本用完即弃；回写副本属误用须在 code review 拦截。 | 注释已写入 normalize-source-text.ts 头部 `NFKC 与「中文标点归一」警示的关系` 段 |

残留门控风险：`npx tsc --build` 仍有 1 处 **既有** 错误 `src/lib/novel/foreshadowing-debt.ts(48,9)`（ForeshadowingStatus 含 `"abandoned"` 与 ForeshadowingDebtItem.status 字面量 `"planted"|"advanced"|"resolved"` 不兼容）。该文件为另一并发会话的未提交 WIP（4 增 1 删），非 A4 改动引入，按范围纪律未触碰；属 A4 验收外的独立门控项，须由该 WIP 归属方修复后方满足「tsc --build 0 错」硬门。A4 自身引入的 tsc 错误已清零（mechanical-slop-detector.ts 移除未用 `normalizeText` 导入）。
