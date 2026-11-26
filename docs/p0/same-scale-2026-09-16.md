# 同尺迁移评测报告（2026-09-16）

> 口径声明：W 面（reference/WeKnora dataset/samples）服务不可运行，未做逐 query
> 跨系统对跑；"同尺"指评测方法同尺（rank 分档 + topK 命中率 + Wilson 95% CI），
> 非同实例对跑。**同源回归口径，不可作收敛结论**（反目标 AG3 豁免标记）。
> W demo 快照 qrels 全标（gold 4/4）导致 topK 恒 1.0，无判别力，仅作方法学对齐参照。

## 一、输入绑定

- P1 面：golden-34（`src/lib/novel/__fixtures__/golden-queries.json`，N=34）
- kb 视图：collectionCounts={"corpus":6,"craft":12,"lexicon":38,"tech":69,"world_ref":8,"blocked":18,"quarantine":26}
- W 面快照：`src/lib/novel/__fixtures__/weknora-snapshot.1ef38fdb.json`
  （sourceCommit=1ef38fdb，queries=1 / corpus=4 / gold=4）
- 基线阈值：minTop3Rate=0.7（golden _meta.baseline）

## 二、P1 臂判定（含 Wilson 95% CI 下界）

- top3 点估计：34/34 = 1.0000
- Wilson 95% CI：[0.8985, 1.0000]
- 判定（看 CI 下界）：**triggered**（阈值 0.7）
- 掉档 query（0）：

## 三、W 面方法学对齐

- W 面服务不可运行，未做逐 query 跨系统对跑；qrels 全标 (4/4) 导致 topK 恒 1.0 无判别力，仅作方法学对齐参照（同为 rank 分档 + topK 命中率）。同源回归口径，不可作收敛结论。

## 四、status.json 同步位

- 本报告为证据快照，未写入 `.novel/status.json`（状态真源唯一，HARD-1）。
- R2-a 扇出/MMR 提名谓词消费本报告存在性（文件存在性硬检查）；非同源矩阵缺失期间强制 locked。
