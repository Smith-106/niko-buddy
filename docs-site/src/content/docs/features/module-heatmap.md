---
title: 运动热力图
description: 模块接线地图 + 运行遥测 + 泳道分层视图
---

# 🔥 运动热力图（v2.17.1+）

写作系统最容易腐化的地方不是算法，而是**接线**——模块写好了却没人调用，管线走了一半就断。热力图把「哪些代码真的在跑、哪些已经死了」变成可视的。

工作台 → **运动热力图** 打开。

## 三层结构

| 层 | 文件 | 职责 |
|---|---|---|
| 静态层 | `scripts/gen-module-atlas.mjs` → `src/lib/novel/module-atlas.generated.json` | 扫描全仓 `src/**` 建 import 图、入口 BFS 判可达、泳道分类 |
| 运行时层 | `src/lib/novel/module-heat.ts` + `src/stores/module-heat-store.ts` | 记录每次模块命中、环形缓冲、对数归一、节流落盘 |
| 呈现层 | `src/components/novel/module-heatmap-view.tsx` | 泳道热度着色、下钻、未接线清单、会话日志 |

## 静态层：接线地图

生成器把每个模块分成三类**可达性判定**：

- `orphan` —— 无人 import（真死代码）
- `specOnly` —— 只有测试引用（生产未接线）
- `barrelOnly` —— 只经 barrel 暴露（架构上的「公开但未使用」）

并按 **12 条主链泳道**（bootstrap → director → incubate → world → outline → plan → draft → gate → accept → memory → review → deliver）加 **8 条支撑泳道**（analysis / agent / knowledge / simulation / ui / state / support / other）分类。

生成物**无时间戳**，因此可做字节级复现门禁：

```bash
npm run gen:atlas   # 重新生成
npm run gen:check   # 6 项产物一致性门禁（第 6 项比对 atlas 字节）
```

当前实测：**1021 模块 / 805 可达 / 216 未接线 / 3598 边**。

## 运行时层：热度遥测

```ts
recordModuleHit("chapter-pipeline", "generate")   // 注入式 sink，未安装时为 no-op
setModuleHeatSink(sink)                            // 由 store 在 install 时注入
```

- 环形缓冲默认容量 2000 条，超出丢弃最旧
- 热度等级用**对数归一**（长尾调用不会把头部压平）
- 落盘节流：15s 或累计 80 条，写 `.novel/telemetry/module-heat.json`
- 失败降级：sink 抛错被吞，不影响主链

已埋点管线：`campaign-runner`、`autonomous-incubator`（六步）、`director-orchestrator`、`chapter-pipeline`。

## 呈现层：视图

- **四色图例**：蓝=当前路径、黄=外部依赖、红=返工回路、灰=未调用
- **六格统计条**：模块总数 / 已接线 / 未接线 / 本会话调用 / 覆盖% / 失败次数
- **泳道**：主链 12 条按流程顺序排列，节点按热度+体量排序，支撑泳道默认折叠
- **返工回路标记**：`gate→draft`、`review→gate` 加红点
- **节点下钻**：点击节点看入边/出边（反向 import map）、行数、调用次数、最近时间、失败数
- **未接线清单**：直接列出 orphan / specOnly，作为补接线的待办

## 为什么不做成一屏全图

1021 个模块一屏画出来只会是毛线球。热力图采用**管线分层 + 下钻**：主视图只呈现 ~40–60 个流程节点，细节点进去看。这样「哪条链在跑、哪条断了」是一眼可读的。
