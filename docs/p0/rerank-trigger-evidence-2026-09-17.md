# rerank 触发证据（2026-09-17）

## 输入绑定

- golden 集：`src/lib/novel/__fixtures__/golden-queries.json`（N=34）
- 基线阈值：minTop3Rate=0.7 / minTop20Rate=0.9
- 判据：top20 守住（top20Rate ≥ minTop20Rate）而 top3 掉档（top3Rate < minTop3Rate）→ 触发 rerank 采纳证据；top20 未达即非触发（状态落 armed）

## 判定

- status：**armed**（golden _meta.rerankTrigger.status 同步位）
- top3：34/34 = 1.0000；top20：34/34 = 1.0000
- top3 Wilson 95% CI：[0.8985, 1.0000]
- top3 掉档候选（0）：（无）
- top20 掉档（0，非触发判据）：（无）

## status.json 同步位

- 本文件为证据快照，未写入 `.novel/status.json`（状态真源唯一，HARD-1）；开关默认值不变。
- R2-a 提名谓词消费本文件存在性；R0-b 不开启 rerank 默认开关。
