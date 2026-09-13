---
title: 下载安装
description: 下载 Niko Buddy 最新版本安装包
---

# 下载安装

## 最新版本

**v2.8.3**（2026-09-13 发布，prerelease 内测语义：安装包资产由 tag 触发 CI 自动构建，验证通过后提升 stable）

前往 [GitHub Releases](https://github.com/Smith-106/niko-buddy/releases) 下载最新 Windows 安装包（macOS/Linux planned）。

### v2.8.3 更新亮点（2026-09-13，三模型共识缺陷猎取 R1–R4）

- ✅ **四轮三模型共识审计** — deepseek-v4-flash + GLM-5.3-flash + qwen3.8-flash 对 7 个高流量面全覆盖（193 findings / 185 行号验证通过 / 62 共识点）；累计修复 **69 项确认缺陷**（24d3db1d、490746de、0b0eb503）
- ✅ **两处数据丢失路径封堵** — preview-panel 读档失败不再把错误文本写进编辑器（防 1s 防抖自动保存覆盖原文件）；graph-view 档案页读档失败不再回退模板内容进入编辑（防保存覆盖真实档案页）
- ✅ **odyssey-ui 外壳修复** — 面板滚动不可达、页面泄露/重叠、MCP 连接状态缺失、英文诊断串直出（4c79ee58）；7 个移植面板接入真实宿主（3b919b00）
- ✅ **错误面与 i18n 统一** — 失败统一 `formatOperationError`（本地化引导 + 原始诊断）；可见坏键 160→0、en 缺译 133→0、zh/en 双侧 2659 一致；批量 a11y（aria-label / role=alert / role=tablist）
- ✅ **验证纪律** — 3 处反证 + 9 处评审债反转 + 28+ 新回归用例；全量 831 文件 / 12793 用例绿 + 实机 e2e 84 通过
- 发布语义：prerelease（10/2 承诺窗口内不发 stable；验证通过后提升 stable）

### v2.8.2 更新亮点（2026-09-12，provider 修复 + 过程债务收敛）

- ✅ **GLM provider 修复** — 思考链下发改用顶层 `enable_thinking` 开关（f06b5242）+ 思考模型在 provider 层获得 max_tokens 6000 下限，思考 token 不再吃光预算（734a80c9）；修复此前 GLM 格子返回 0 字节 / `finish_reason=length` / 取不到评分的失败
- ✅ **公共导入面收束（T18）** — 458 处 app 侧导入迁移至单一 barrel（55aab6b7）；eslint 警告棘轮 162→100→0，boundaries 门禁迁移 v7 文件类别 + 正负 fixture 并升为硬门，`--max-warnings` 删除（a39be4f3、82085c72）
- ✅ **过程债务收敛批次** — app 侧 Python 归零（fecc618f）/ PS1 内联块下沉 Node + 签名键单源（5a852d3e）/ `.test.ts` 白名单归零（f3c921fc）/ bench 基线写盘与受控源解耦（60e3ca81）/ retry sunset 钉 v2.9.0（ce942222）/ `patterns.cjs` eval 沙箱改直接 ESM 导入、new Function 归零（02036e2e）/ analytics-worker 过渡期 CI 门接线（0c8f7a25）
- ✅ **CI 与测试稳定性** — e2e webServer 改服务构建产物（vite build + vite preview），两处 120s 超时特例删除（ubuntu 4.25min→0.25min、windows 失败 6.21min→成功 1.91min）（e690bbf3）/ build.yml 三平台统一断言 protoc（f0a4a5fa）/ Node-20 action 运行时归零（5d46d2aa）/ llm-provider-section 未清理定时器修复（9bf01382）
- ✅ **证据入库** — C1/C2 语料与 hash 清单入版本库（aa6a0a55）；工程收敛批次补录 changelog（47521dfc）；C4 preferred-panel stretch-2 重测证据 + hash 清单，含 GLM token 下限仪器变更披露（b6f1d0df、43cd1dbe）
- 发布语义：prerelease（10/2 承诺窗口内不发 stable；验证通过后提升 stable）

### v2.8.1 更新亮点（2026-09-09，过程债务清偿批次）

- ✅ **B1 补录 5 个 post-tag 清偿 commits** — P1-3 DoD 迁移 vitest specs + v26x 归档 / P2-1 ab-* 脚本 cjs→mjs ESM 规范化 / P2-5 canon 域分组入 canon/ 模块目录（纯移动零签名变更）/ R1 kappaAgreement 复活（内联 Cohen kappa，诊断面指标）/ R3 全仓 cargo fmt 规范化 + CI rust-fmt 门
- ✅ **B2 eslint 棘轮回紧 163→162** — --max-warnings cap 回紧至实测值，T18 barrel 重构继续下行
- 发布语义：prerelease（v2.7.9 豁免承诺至 10/2 不发 stable；验证通过后提升 stable）

### v2.8.0 更新亮点（2026-09-09，R5 检索实测 + UI 补全 + 隔离加固）

- ✅ **KB 影子双臂检索实测 harness** — 真实码路零镜像（routeByQueryIntent/tokensForKbMatch/rankByBm25/reorderByUsefulness），golden 34 双臂 baseline hitRate/top3/coverage 1.000 + paired 不变式；eval-gov-gate 实测消费 68 行（34/34 缺失 0）
- ✅ **判别力毒化压力臂 v2（治疗-对照设计）** — veto 臂（带标记）覆盖恢复 +64.7pp（22/34，如实标注否决规则自洽面）vs fit 对照臂（无标记）0.0pp——增益归属锚定否决信号本身；差异化先验阈值 fail-loud，双断言入 test:mocks 常态套件（零 IO）
- ✅ **设置页 KB 路由区** — dualKbRoutingEnabled / usefulnessRerankEnabled / hardInjectEnabled 三开关 + entityBoostWeight 0-1 权重输入
- ✅ **设置页内容装配区** — exemplar / relatedChapters / reference / sceneBreakdown / conditionalRouting / inspector / stateDeltaBlocksTrackA 七开关
- ✅ **治理 E-06 只读徽章** — 三项 DEFERRED 项徽章化呈现（不开 Switch，如实标注未接线）
- ✅ **R5 采集触发 UI** — 同意门 + 按钮触发 + 串行互斥 + 状态文案（设置页内完成影子采集全流程）
- ✅ **数据隔离加固** — 隔离审计 10 面核验全 ✓（LanceDB 项目级 / kb-shadow 遥测项目目录 + harness 独立根 / 三缓存键控 / consent 应用级 + 数据项目级 / single-instance / 原子写 / Draft-first）+ consent 作用域显式裁决（升级触发器已定）

### v2.7.8 更新亮点（2026-09-06，64 号实施：三轴 20 缺口）

- ✅ **多文件原子事务** — write_files_atomic（temp 写入 + 统一 rename + 失败回滚零 rename）
- ✅ **章节 source 五标签** — manual/llm/campaign/template/migrated（三标签无损扩展）
- ✅ **RAG 注入审计 12/12 全层覆盖** — prompt-injection-auditor 9 规则零 LLM 机械扫描（layer-8 回注）
- ✅ **FTS5 bigram 持久索引** — rebuildWikiFtsIndex 可重建（含中文切分）
- ✅ **查询分解 + multi-query RRF 融合** — 意图分类 → 子查询计划 → 结果融合
- ✅ **分支正史绑定** — 框架签名 + staleness 检测 + 过期清理
- ✅ **互动影游** — 节点图 + 情感评估 + ink/HTML 导出 + Play 崩溃续玩
- ✅ **同人四模式 + 正典合并** — canon/au/ooc/cp 机械校验 + Draft-first pending 工件
- ✅ **翻译执行链** — 术语表驱动 + 分段续跑复用预算机
- ✅ **封面生成** — aspect 表驱动任务组装 + provider 端口注入 + 幂等 skip
- ✅ **Webhook 守护** — HMAC 签名 + 回调验签（密钥仅函数参数）
- ✅ **项目医生** — 6 基础 + 3 形态挂载诊断（只读）
- ✅ **自动连写 + 卷弧滚动** — advanceBudgetBatch（--count）+ 起承转合 2:3:3:2

### v2.7.7 更新亮点（2026-09-04，参考池覆盖 v2）

- ✅ **genre 单真源全链** — NovelConfig.genre + genre-codes 9 码映射 + 三调用点透传
- ✅ **数值事实检查** — numeric-fact-checker 14 类（warn-only，中文数字 CN_NUM_RE 处理）
- ✅ **自重复率激活** — rep_2/3/4 第 5 因子（阈值 0.35 warn-only，2026-09-04 激活）
- ✅ **CJK 切分增强** — cjk_clauses 层 + chunk-fingerprint v1: 版本位（URL/时间不误切）
- ✅ **mojibake 修复默认开启** — UTF-8 双重编码乱码自动还原（正常文本零变更）
- ✅ **RAG 注入安全审计** — 12 层矩阵 11/12 覆盖（license 先核纪律）
- ✅ **humanizer 115 条模式矩阵** — 45 覆盖/68 豁免/2 缺口（索引回流 + 一致性归零）
- ✅ **覆盖度 100%** — L1 34/34 / L2 9/9 / L3 40/40（声纹激活 + 编辑影响分析 + 9 项重新判定）
- ✅ **EPUB 往返验收 PASS** — PYTHONIOENCODING=utf-8 修复 GBK 乱码根因

### v2.6.4 更新亮点（2026-08-26，检测对抗强化）

- ✅ **对抗回归集框架** — 作弊样本库分层召回 + 诚实报告（stub 显式标注）
- ✅ **双向似然接口** — LLR 计算/降级语义/因子注册表
- ✅ **原笔指纹** — 作者笔迹 DNA 抽取 + 漂移检测

### v2.6.0 更新亮点

- ✅ **EPUB/HTML 摄取** — 特化摄取管线 + 提取器注册表，导入素材按文档类型自动分派
- ✅ **跨页 chunk 指纹去重** — SHA-256 指纹索引，重复片段只入库一次
- ✅ **图谱双层精度过滤** — 机械层校验 + 语义层复核，拦截幻觉边
- ✅ **Compaction** — chunk 表自动压缩碎片化记录 + 纯函数对账
- ✅ **断点 TTL 配置 + 伏笔废弃态** — 断点过期自动清理；abandoned 不再计入活跃债务
- ✅ **决策回放面板** — 上下文包逐条展示组入记忆与取舍依据
- ✅ **角色工作台** — 角色档案/状态/认知/关系集中视图
- ✅ **章节自评估** — 输出 `{score, gap, fix}` 三要素，返修前锁定问题点

### v2.5.1 更新亮点（2026-08-21，notes-only）

- CI 工程卫生、文档站部署链修复、CHANGELOG 补齐（详见应用内 changelog）

### v2.5.0 更新亮点（历史，2026-08-18）

**v2.5.0**（2026-08-18 发布，源码 tip 与安装包资产对齐）

- ✅ **用户记忆（Wave 1）** — 跨会话用户偏好/事实记忆，写作偏好自动沉淀
- ✅ **@引用（Wave 2）** — 正文/大纲/记忆三域 @引用，上下文精准注入
- ✅ **计划模式（Wave 3）** — 章节计划驱动生成，长文写作确定性提升
- ✅ **批量去 AI 味（Wave 4）** — 多章节批量 de-ai 处理，风格一致性增强
- ✅ **上下文用量圆环（Wave 5）** — 实时上下文用量可视化，防超限

> 源码 tip 与安装包资产同步（`smith/master`）；以 [Releases](https://github.com/Smith-106/niko-buddy/releases) 资产为准。

### v2.4.7 更新亮点（历史）

- ✅ **Roadmap 3-session 执行管线** — 质量门控 + 连续性约束 + 检索智能
- ✅ **S1 机械层硬化** — 零宽字符/同形字还原、格式规范化、hybrid_search 多信号融合、facts 时间窗表、de-ai 双层规则
- ✅ **S2 连续性深化** — 四维反查 + 伏笔逾期、chase_debt 追读债务、Story Threads 6 态状态机、测量指纹契约
- ✅ **S3 质量** — Gate v2 加权 P2 参考 + reading_power、i18n parity（修复 194 翻译缺口）、伪端点契约测试
- ✅ **EPIC-005 persona 侧车** — 人物认知错误 UX + 侧边栏 UI

### v2.4.6 更新亮点（历史）

- ✅ **Tip-aligned 安装包重建** — NSIS + 便携版与 mid-loop 源码对齐
- ✅ **Avoid-AI 全量 patterns** — Track B 软诊断（非产品硬门）
- ✅ **文学金标 / skill hooks / 测量指纹** — 创作链路可观测增强
- ✅ **Headless 脚本** — pack export / gold smoke / formal LLM extract

### 历史里程碑

| 版本 | 说明 |
|------|------|
| v2.4.5 | Quality Foundation v1（记忆/结构过程） |
| v2.4.4 | 角色光环、MIT 合规、性能基准 |
| v2.4.0 | 确定性连续性引擎 |

## Windows 安装包

下载 [`QMaiWrite_2.5.0_windows_X64.exe`](https://github.com/Smith-106/niko-buddy/releases/download/v2.5.0/QMaiWrite_2.5.0_windows_X64.exe)（约 33 MB，v2.5.1 为 notes-only 源码版本，安装包沿用 v2.5.0 资产），双击运行 NSIS 安装程序即可。

## 便携版

下载 [`QMaiWrite-portable.exe`](https://github.com/Smith-106/niko-buddy/releases/download/v2.5.0/QMaiWrite-portable.exe)（约 148 MB），解压后直接运行，无需安装，适合 U 盘随身携带或免安装场景。

## 系统要求

- **操作系统**：Windows 10 及以上（主要支持平台）、macOS（planned）、Linux（planned）
- **LLM 服务**：需配置至少一个大语言模型 API（支持 OpenAI 兼容接口、Ollama 等）

## 自动更新

内置 Tauri Updater，启动时自动检测 GitHub Releases 新版本并提示更新。Windows 平台更新前会等待主程序释放文件句柄，避免“无法卸载”错误。

:::note[关于已装 v2.4.1（2026-07-21 版）的用户]
该版本的更新通道在编译期指向了旧仓库地址，自动更新无法到达新版本。请手动前往 [Releases](https://github.com/Smith-106/niko-buddy/releases) 下载最新版覆盖安装——v2.4.2+ 已将更新通道修正至本仓库，此后即可正常接收自动更新。
:::

## 数据管理

支持一键导出/导入全部数据（AI 会话、大纲、模型、记忆），重装系统可完美恢复。
