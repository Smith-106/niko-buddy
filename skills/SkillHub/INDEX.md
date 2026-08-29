# SkillHub 总索引

本目录用于存放 QMAI 可路由 Skill。Skill 名称不使用来源仓库名称，只按创作任务和内容类型命名。

## 分类

| 文件夹 | 用途 | 当前状态 |
|---|---|---|
| `DagangSkill/` | 大纲、总纲、章纲、开书流程 | 已存在，保留 |
| `TicaiSkill/` | 男频、女频、短篇、题材专用规则与 AI 大纲题材路由 | 本轮新增 |
| `SheDingSkill/` | 世界观、力量体系、势力、地图、伏笔、市场定位 | 本轮新增 |
| `JueseSkill/` | 角色设计、关系线、配角配置 | 本轮新增 |
| `QualitySkill/` | 大纲、章纲、人物、设定、保存协议的质量检查 | 本轮新增 |
| `ZhengwenSkill/` | 正文协作区专用，后续读取已确认章纲 | 已存在，非 AI 大纲默认链路 |

## 全局标准文件

- `AI_OUTLINE_OUTPUT_PROTOCOL.md`：AI 大纲对话输出和自动保存协议。
- `OUTLINE_FOLDER_STORAGE_STANDARD.md`：大纲文件树、默认文件夹、移动和保存规范。
- `ROUTE_MANIFEST.json`：程序可读取的题材路由、默认文件夹和输出类型清单。
- `ROUTING_MEMORY.md`：给 AI 使用的文字版路由记忆。

## 路由原则

1. 生成大纲或章纲时，先加载 `DagangSkill/`。
2. 用户选择题材后，加载 `TicaiSkill/` 中对应题材 Skill。
3. 题材涉及世界观、能力、门派、地图、伏笔时，追加 `SheDingSkill/`。
4. 题材涉及强人物关系、感情线、群像时，追加 `JueseSkill/`。
5. 输出保存内容时，遵循 `AI_OUTLINE_OUTPUT_PROTOCOL.md` 和 `OUTLINE_FOLDER_STORAGE_STANDARD.md`。
6. 进入保存或下一步生成前，可追加 `QualitySkill/outline-quality-check` 做质量门。
7. AI 大纲阶段不默认追加 `ZhengwenSkill/`；正文协作区后续读取已确认章纲再单独处理正文。

## 来源提取说明

本轮 Skill 从以下本地资料提炼，不直接保留来源仓库命名：

- 长篇题材框架、题材核心机制、女频长篇手册、短篇风格包。
- 初始化题材套路、世界观/力量体系/势力规则、卷级节奏模板。
- 本地资料中的创意阶段、市场定位、规则怪谈、都市高武、短篇样例 Prompt。


