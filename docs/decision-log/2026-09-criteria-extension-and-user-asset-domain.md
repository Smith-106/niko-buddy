# 2026-09 双库判据扩展与「用户资产域」

- **状态**：Accepted
- **日期**：2026-09-12
- **范围**：跨项目移植专项（OpenWrite 2.0.1 / FeelFish 4.0.36 → QMAI）
- **锚定**：`guidance-specification.md` §12.3 **C-006 / C-007 / C-010**；`cross-role-review.md` **§A-1 / §A-2**
- **相关裁定**：C-004（双库四判据，locked）、C-013（命名纪律）、C-014（门禁先行）
- **实现**：`src/lib/novel/projection-status-ledger.ts`、`src/lib/novel/user-asset-domain.ts`、`src/lib/novel/projection-self-heal.ts`

## 背景

既有 C-004 用四条判据（**形态 / 消费者 / 生命周期 / 重建性**）为项目内持久化对象裁定归属（过程库 `.novel/` 或资料库 `QM/`），并锁定「不得新建第三库」。跨项目专项引入两类新数据后，四判据暴露不完备（cross-role-review §A-2 已承认）：

1. **外部时间事实**——榜单 / 市场数据。同一来源在不同时间返回不同内容：**重抓 ≠ 重放**。若按「重建性」判为可重建并纳入 fold 重算，重放会写出与当下外部世界不一致的「事实」，污染 P2 并将厂商 API 变成间接的 P0/P1 输入通道。
2. **外部不可信输入**——技能包本体 / 远程 MCP 返回 / 抓取样本。四判据**不含信任维度**，无法表达「可入库但不可执行、不得默认提信」。
3. **跨项目、用户级资产**——技能包本体。它不属于任何单个项目、删除即永久丢失、且必须被程序机读；把它塞进项目内任一库都会违反「不得新建第三库」或破坏「项目内只存引用」的既有惯例（参见 `user-skill-store` 的 `.qmai/writing-skills.json` 治理目录先例）。

## 决策

### D1（C-010）：新增两根**属性轴**，不新增库、不新增投影类别

在 `projection-status-ledger.ts` 新增与 `ProjectionCategory` **正交**的轴：

```ts
export type ExternalDataClass = "external_refetchable" | "untrusted_input"
```

| 类 | `foldRebuildable` | `entersSelfHeal` | `provenanceRequired` | `trustLevel` | `domain` |
|---|---|---|---|---|---|
| `external_refetchable` | **false** | **false** | true | `untrusted` | `qm_raw_source` |
| `untrusted_input` | **false** | **false** | true | `untrusted` | `user_asset` |

**关键约束**
- 二者**不是 projection category** → 不入 `PROJECTION_CATEGORIES` / `PROJECTION_REGISTRY`。理由：`assertProjectionRegistryComplete()` 断言「注册表键集 == `PROJECTION_CATEGORIES` 键集」，若把外部数据类塞进该映射，必须同时伪造注册条目，会把「投影」概念污染到外部数据上。
- **互斥断言**：`fold_rebuildable ∧ external_refetchable = false`（同名对象不得同时被标为可重放与外部时间事实）。由 `isFoldReplayExcluded()` 承载。
- **判定器** `resolveExternalDataClass({ externalOrigin, timeVarying, executable })`：判定顺序固定（可执行 > 时间事实），保证同一份数据在任何调用点得到同一类别；非外部来源返回 `null`（走既有四判据）。

### D2（C-007 / C-010）：新增「用户资产域」，并给出「域 ≠ 库」的机械判据

域语义（五项同时成立）：**跨项目 · 用户级 · 不可重建 · 机读 · 项目内只存引用**。

- `USER_ASSET_ROOT = ".qmai/user-assets"`（用户级、跨项目；**不在任何项目树内**）
- `USER_ASSET_REF_FILE = ".novel/user-asset-refs.json"`（项目侧唯一落点，**只存引用**）

**「域」与「库」的区分判据（可脚本化）**
| # | 判据 | 库 | 域 |
|---|---|---|---|
| D1 | 路径根 | MUST 独占一个项目内顶层根（仅 `.novel/`、`QM/`） | MUST NOT 新增项目内顶层根；对象落用户级路径，项目内只存引用 stub |
| D2 | writer | 单一 writer 模块 | 靠属性 `ownership=user_asset` 跨库标注 |
| D3 | 重建性 | 对象可被项目重建 / 删除 | 对象 **MUST NOT** 被项目删除或重建 |
| D4 | 内联禁令 | — | 项目树内出现包本体二进制（`*.nbskill` / 脚本 / 凭据）即 fail；只允许 uri/ref + hash |

**反例（违规判定）**：把用户资产域实现为项目内 `QM/assets/` 即退化为**第三物理库** → 违规。
**强制点**：GC 执行器的豁免清单 MUST 以**路径前缀**表达（可审计），不允许「域」成为绕过配额的黑洞。

### D3（C-007）：可执行脚本通道整体否决

`USER_ASSET_EXECUTABLE_EXTENSIONS` 收录三平台（Windows / macOS / Linux）可直接执行或有执行语义的扩展名并集（42 项，含 `exe/dll/msi/bat/cmd/ps1/vbs/js/mjs/jar/sh/bash/zsh/bin/app/dmg/pkg/deb/rpm/so/dylib/py/rb/pl/lua/lnk/reg/sys` 等）。
- `hasExecutableExtension(fileName)`：大小写不敏感，认路径；`README` / `.gitignore` / `trailing.` 不误判。
- `findExecutableAssets(fileNames)`：一次返回**全部**命中项（供一次性给出完整错误清单），空数组 = 通过。
- 与 SA/DA 视角的 G-6 schema 契约（deny-by-default、零网络、零 spawn、纯函数解析）配套，由 F-002 导入路径消费。

### D4（C-010）：外部时间事实与用户资产域均**禁入 fold 重算与 self-heal**

新增 `projection-self-heal.ts` 作为**自愈门槛的单一策略源**（不实现自愈本身——实现仍在既有 ingest / ledger 路径，避免形成第二条自愈链）：

- `SELF_HEAL_SKIP_CLASSES = ["external_refetchable", "untrusted_input"]`（字面量单一事实源）
- `assertSelfHealSkipSetConsistent()`：**模块加载即校验**字面量集合 == 属性表派生集合，任何一侧漏同步即抛（fail-loud，与 `PROJECTION_REGISTRY` 注册即校验同纪律）
- `mayEnterFoldReplay(projection, isRebuildable)`：新类别一票否决，其余交由既有 `isAutoRebuildableProjection` 判定（**不改变既有门槛语义**）
- `isUserAssetRefPath(path)`：项目侧用户资产引用文件标记

## 后果

**正向**
- 外部数据获得合法落位，且**结构上**（非文档约定）无法进入 fold 重放 / 自愈 / 门控输入通道。
- 「不新建第三库」与「用户资产域」由机械判据调和，不再依赖人工裁量。
- 为 F-001（榜单原始抓取 / 规范化摘要 / 运行时缓存三层）与 F-002（技能包本体 / 安装副本 / 启用状态三分）预留了分类位。
- 可执行脚本通道在**入口层**整体否决，而非依赖运行期防护。

**代价 / 约束**
- 新增轴与既有 `ProjectionCategory` 平行，读者须理解两轴正交（已在源码注释与本文档说明）。
- 用户资产域的 GC 豁免须由配额执行器按路径前缀实现，否则 D2 判据失效。
- `SELF_HEAL_SKIP_CLASSES` 为字面量 + 派生校验双写，新增类别时两处须同步（有 fail-loud 兜底）。

## 验证

| 判据 | 命令 | 结果 |
|---|---|---|
| 判据扩展落位 | `rg -n 'external_refetchable' src/lib/novel/projection-status-ledger.ts` | 命中 5 |
| 信任维度落位 | `rg -n 'untrusted_input' src/lib/novel/projection-status-ledger.ts` | 命中 6 |
| 用户资产域根常量 | `rg -n 'USER_ASSET_ROOT' src/lib/novel/user-asset-domain.ts` | 命中 2 |
| 项目侧引用文件 | `rg -n 'user-asset-refs' src/lib/novel/user-asset-domain.ts` | 命中 2 |
| 自愈跳过集合 | `rg -n 'external_refetchable\|untrusted_input' src/lib/novel/projection-self-heal.ts` | 命中 4（均位于跳过集合与一致性校验） |
| 单测 | `npx vitest run src/lib/novel/projection-status-ledger.spec.ts src/lib/novel/projection-self-heal.spec.ts src/lib/novel/user-asset-domain.spec.ts` | 见专项验收记录 |

## 未决 / 交给下游

1. **配额与 GC 数值阈值（C-012）**：本决策只确定「域」的 GC 豁免表达方式；具体阈值（`.novel/` 软 2 GB / 硬 3 GB、候选子树 1 GB、未 accept 候选 TTL 7 d 等）由 DA 视角共识给出草案，待独立任务落地。
2. **注册表盲区**：新数据对象若既不登记进 `PROJECTION_REGISTRY` 也不走 `.novel/` 配额执行器，将同时逃过自愈与 GC —— 该不变量须由后续任务的断言固化。
3. **别名 / 等价实现风险**：本轮 grep 采用「0 命中式」否定证据，不能排除同义族实现（`export/pdf/render`、`rollback/restore`、`lock/credential`），建议二次语义检索。
