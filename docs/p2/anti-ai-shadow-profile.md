# 反AI四因子影子画像 — 特征提取轨（未授权来源）

> ⚠ **合规声明（必读）**
> - 来源: `D:/writing` 商业网文/出版小说（**未获授权的版权文本**）
> - 方法: 原地只读特征提取（§5.1 许可），文本本体不落盘不入库，仅输出聚合统计量
> - 效力: **仅内部统计参考** —— 禁止作为发版宣称、block 档解锁、DEBT-t20 解锁依据
> - 正式标定仍以 runbook §1 授权语料轨为准 | 生成: 2026-08-23
> - 参照索引: synthetic-degraded 种子 batch-20260821-001（与正式标定同源）| 总单元数: 4080
> - 采样口径: **生产等价单元**（无≥30字过滤, ~2500字窗×≤12窗全书等分偏移;
>   20260823 修复旧版三条采样伪影, 见 decision-log t01b 追记五/七）
> - 单元阈值面: T19（PL CV<0.3/短文0.35; 熵归一化<0.7; 标点余弦>0.85×1.2; ngram>0.4×1.5）

## 各族 × 各因子分布（生产等价单元）

### 玄幻（720 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.910 | 0.914 | 0.955 | 0.0% |
| punctuationFingerprint | 0.934 | 0.940 | 0.987 | 0.0% |
| paragraphLengthDist | 0.663 | 0.652 | 0.907 | 0.0% |

### 古风（720 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.911 | 0.917 | 0.955 | 0.0% |
| punctuationFingerprint | 0.934 | 0.939 | 0.987 | 0.0% |
| paragraphLengthDist | 0.617 | 0.595 | 0.900 | 0.1% |

### 言情（36 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.880 | 0.878 | 0.939 | 0.0% |
| punctuationFingerprint | 0.914 | 0.921 | 0.975 | 0.0% |
| paragraphLengthDist | 0.729 | 0.730 | 0.867 | 0.0% |

### 悬疑（252 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.921 | 0.923 | 0.978 | 0.0% |
| punctuationFingerprint | 0.844 | 0.935 | 0.988 | 0.0% |
| paragraphLengthDist | 0.664 | 0.637 | 0.986 | 0.0% |

### 都市（720 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.894 | 0.906 | 0.956 | 0.0% |
| punctuationFingerprint | 0.908 | 0.934 | 0.981 | 0.0% |
| paragraphLengthDist | 0.652 | 0.633 | 0.956 | 0.0% |

### 科幻（396 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.908 | 0.911 | 0.962 | 0.0% |
| punctuationFingerprint | 0.927 | 0.935 | 0.989 | 0.0% |
| paragraphLengthDist | 0.672 | 0.671 | 0.928 | 0.8% |

### 西幻（192 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.908 | 0.916 | 0.950 | 0.0% |
| punctuationFingerprint | 0.948 | 0.954 | 0.992 | 0.0% |
| paragraphLengthDist | 0.638 | 0.652 | 0.837 | 0.0% |

### 历史（444 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.902 | 0.911 | 0.958 | 0.0% |
| punctuationFingerprint | 0.905 | 0.929 | 0.985 | 0.0% |
| paragraphLengthDist | 0.626 | 0.619 | 0.890 | 0.7% |

### 游戏（420 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.904 | 0.908 | 0.952 | 0.0% |
| punctuationFingerprint | 0.906 | 0.924 | 0.987 | 0.0% |
| paragraphLengthDist | 0.693 | 0.674 | 0.943 | 0.0% |

### 轻小说（180 单元，均视为 human 侧参照）

| 因子 | mean | P50 | P95 | warn 触发率 |
|---|---|---|---|---|
| nGramOverlap | 0.000 | 0.000 | 0.000 | 0.0% |
| sentenceEntropy | 0.888 | 0.893 | 0.943 | 0.0% |
| punctuationFingerprint | 0.926 | 0.939 | 0.977 | 0.0% |
| paragraphLengthDist | 0.707 | 0.674 | 1.020 | 0.0% |

## 书本级聚合视图（每书 mean-CV + any-warn 书口径 FPR）

- **玄幻**: book-mean-CV P5=0.474 P25=0.598 P50=0.672（n=60 本）
- **古风**: book-mean-CV P5=0.493 P25=0.533 P50=0.588（n=60 本）
- **言情**: book-mean-CV P5=0.672 P25=0.672 P50=0.738（n=3 本）
- **悬疑**: book-mean-CV P5=0.472 P25=0.545 P50=0.665（n=21 本）
- **都市**: book-mean-CV P5=0.481 P25=0.563 P50=0.657（n=60 本）
- **科幻**: book-mean-CV P5=0.473 P25=0.617 P50=0.669（n=33 本）
- **西幻**: book-mean-CV P5=0.423 P25=0.611 P50=0.665（n=16 本）
- **历史**: book-mean-CV P5=0.469 P25=0.553 P50=0.613（n=37 本）
- **游戏**: book-mean-CV P5=0.503 P25=0.659 P50=0.693（n=35 本）
- **轻小说**: book-mean-CV P5=0.507 P25=0.635 P50=0.697（n=15 本）

| 阈值 | 全体书本 any-warn FPR | n=书本数 |
|---|---|---|
| CV<0.30 | 0.88% | 340 |
| CV<0.35 | 4.41% | 340 |

## 种子基线对照（synthetic-degraded 30 篇 human 同管线）

| 因子 | n | warn 触发率 |
|---|---|---|
| nGramOverlap | 30 | 0.0% |
| sentenceEntropy | 30 | 0.0% |
| punctuationFingerprint | 30 | 0.0% |
| paragraphLengthDist | 30 | 0.0% |

## 读法说明

> ⚠ **20260823 反转警示**：旧版过滤切片口径（≥30 字段落过滤/500 字窗/仅前 8000 字）曾产生
> 35–53% 的伪影 warn 率。本版已对齐生产等价单元；正式轨测量必须走 runbook §1 测量单元纪律。

1. warn 触发率是「生产等价单元口径下的相对信号」，跨族比较需书本级聚合校正后才有效
2. 正式轨测量以 rederive-pl-threshold.mjs 口径为准；本脚本仅供内部表征与缺口可视化（如言情饥饿）
3. 本画像不产生 PASS/FAIL 判定——那是正式轨（授权语料 ≥100/族，按族独立解锁）的职责
