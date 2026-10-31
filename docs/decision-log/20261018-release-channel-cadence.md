# 发布渠道与节奏策略（可机械检查化）

- 日期：2026-10-18
- 状态：生效
- 关联：`RELEASING.md`（发布规范）、`release-cadence-exemptions.json`（豁免登记）、`scripts/check-release-cadence.mjs`（机械检查）

## 背景

`RELEASING.md` 早已规定「stable 每周 ≤1、同日重复 tag = 0、近 30 天 stable ≤4」，但检查方式一直是人工核对
`gh release list` + CHANGELOG 日期链（65 号共识 G5）。人工核对的实际后果是：**规则存在、违规持续**——
截至 2026-10-18，仓库 54 个 stable 发布中有 12 个「多 stable 周」、7 个「多 stable 日」，
最密集的一周（2026-08-24）发了 14 个 stable。

因此把该硬检落成脚本，并把判定口径明确成两条，避免再次流于纸面：

1. **门禁只判「被审版本」**（默认 Latest，可 `--tag` 指定），不回头重判历史；
2. **历史违规以 INFO 汇总**输出，供审计可见，但不重复计罚。

## 渠道定义

| 渠道 | 标记 | 判定 | 谁在用 |
|---|---|---|---|
| stable | 非 `prerelease`、非 `draft` | `gh release edit --latest` 归属 Latest，updater 指向它 | 全体用户 |
| prerelease（内测） | `--prerelease` | 不进 Latest，updater 不指向 | 内测/验证 |

规则：**候选版一律先发 prerelease**，验证通过后再提升 stable。被审版本若本身是 prerelease，
节奏门不适用（`evaluateTarget` 返回空规则并给出 WARN）。

## 节奏规则（对 stable 生效）

| 规则键 | 判定 | 依据 |
|---|---|---|
| `weekly-stable` | 同一 ISO 周（周一为周首，本机时区）stable ≤ 1 | RELEASING「stable：每周 ≤1 个」 |
| `same-day-duplicate` | 同日本地日期 stable = 0（即同日最多 1 个） | RELEASING「同日重复 tag：重复 tag 一律拒绝」 |
| `thirty-day-stable` | 被审版本往前推 30 天内 stable ≤ 4 | RELEASING 发布后检查清单第 5 条（65 号共识 G5） |
| 资产 | `latest.json` + 安装包 `*.exe` 必有同名 `.sig`；`*_portable.exe` 按设计无 sig | RELEASING「资产命名（唯一规范）」。审 Latest 时 prerelease 标记本身判违规；`--tag` 指定的版本不是 Latest 时不判（只查资产与 draft） |
| 主干 | 被审版本 tag 必须是 `smith/master` 祖先 | RELEASING 发布后检查清单第 6 条 |

## 豁免流程

豁免是**例外而非常态**，必须同时满足：

1. 属 RELEASING 定义的 fix-forward 情形（资产补齐 / 断链 / 更新链路修复类补救发布）；
2. 用户明确批准；
3. 在 `release-cadence-exemptions.json` 登记 `tag` / `reason` / `approvedBy` / `approvedAt` / `scope`；
4. `scope` 必须逐条列出被豁免的规则键——未列入的规则照常判 FAIL（不会因登记而整体放行）。

已登记豁免：

| tag | 范围 | 理由 |
|---|---|---|
| v2.17.1 | `weekly-stable`、`thirty-day-stable` | fix-forward：修复 v2.17.0 遗留的 release 门禁缺陷（`gen-module-atlas` 跨环境字节漂移导致 `Generated artifacts check` 失败、tag 构建产不出资产），用户 2026-10-18 批准登记 |
| v2.18.0 | `thirty-day-stable` | 用户明确批准登记豁免（2026-10-19 会话决策）：v2.18.0 为门禁全绿的功能发布（动态工作热力/风格节奏雷达/资产联动与提取缺口/Agent 能力矩阵/冗余精简），发版当日本地四道硬门 + 全量 1169 files / 15214 tests 全绿；近 30 天 stable 计数超出上限属既有高频发布节奏所致，非跳过门禁。（批准于 2026-10-19） |
| v2.18.1 | `weekly-stable`、`thirty-day-stable`、`same-day-duplicate` | 用户明确批准登记豁免（2026-10-19 会话决策，选择「发补丁版 v2.18.1」）：v2.18.0 发版后 grok-4.7(xhigh) 终局对抗式审查判 BLOCK（无 P0，6 条 P1 + 5 条 P2），本补丁为修复性发布。same-day-duplicate 规则在此不适用其本意（该规则禁止的是同一 tag 当日重复，这里是 v2.18.0 → v2.18.1 两个不同 tag 的先后发布，未重打任何已发布 tag）。修复提交 b3ee292c 上全量 1174 files / 15265 tests 全绿，四道硬门全过，未跳过任何门禁。（批准于 2026-10-19） |
| v2.19.0 | `weekly-stable`、`thirty-day-stable`、`same-day-duplicate` | 用户明确批准（2026-10-19 会话，在本地真机安装 2.19.0 并运行后两次确认繼續）：15 灰卡转正功能版（WaveA/B/C 只读真实视图）+ 对抗审查修复。typecheck/lint/consistency/mocks/gen:check 全绿，Release CI success，Windows 三资产齐。tag 曾因 atlas 生成物漏 regen 导致门禁 failure，按纪律删除零资产旧 tag/release 后重打（未重打任何已发布带资产 tag），重打后 CI success 才重建 release。（批准于 2026-10-19） |
| v2.21.0 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-10-22 明确要求把 v2.21.0 由 prerelease 提升为正式版。原 tag 停在门禁失败、零资产的 a0431b43；修复已在 smith/master 且 CI 39731981080 全绿。零资产 tag 改指到该提交后由 Release 构建附上 Windows 安装包。同周已有 v2.20.0 stable，近 30 天 stable 亦超过上限。（批准于 2026-10-22） |
| v2.22.2 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-10-30 明确批准登记豁免：v2.22.2 为当前 Latest（v2.23.0 按 changelog 语义发为 prerelease），release:cadence 默认审 Latest 时因既有高频发布节奏 FAIL：ISO 周 2026-10-19 有 6 个 stable、发布前 30 天 stable 17 个（上限 4）。发版门禁当时全绿，超限不是跳过门禁。（批准于 2026-10-30） |
| v2.24.0 | `weekly-stable`、`thirty-day-stable` | 用户于 2026-11-01 明确批准将 v2.24.0 由 prerelease 提升为 Latest。v2.24.0 的 publishedAt 为 2026-11-01，与 v2.23.1（2026-10-31）同属 ISO 周 2026-10-26，该周 stable 计数为 2；近 30 天 stable 17 个属历史高频节奏。提升时四道硬门全绿、全量 16187 项单测与 E2E 27 项通过、独立复核 approve，Release CI 41224998281 与 CI 41225010889 双 success。（批准于 2026-11-01） |

> v2.17.1 与 v2.17.0 同 ISO 周（2026-10-12 → 10-18），属真实节奏超限，此处按 fix-forward 豁免登记，
> 而不是回改历史或把已发布版本降级为 prerelease（后者会让已升级用户收到降级提示）。

## 用法

```powershell
npm run release:cadence                 # 审 Latest
npm run release:cadence -- --tag v2.17.1
npm run release:cadence -- --json       # 机器可读（CI / 验收脚本）
```

退出码：`0` 通过（含豁免）/ `1` 有未豁免违规 / `2` 环境不可用（gh 或 git 失败）。

发布后检查清单里的人工「节奏审计」现由该脚本承担；`release-cadence-exemptions.json` 的任何新增
都必须在 release body 与本文档「已登记豁免」表中同步留痕。
