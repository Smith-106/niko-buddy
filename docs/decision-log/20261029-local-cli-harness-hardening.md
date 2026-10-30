# 20261029 本地 CLI harness 加固（D1–D5 修复）

> 执行：session-bdb27738（S3 单人单件流，已声明）。复核：独立上下文子代理只读审查，结论见文末。
> 范围：`release/v2.22.2` 工作区，未 commit / push；不碰版本、CHANGELOG、generated 与他方未提交的 `src/lib/llm-providers*.ts`。

## 一、决策条目

| date | task_id | decision_type | value | evidence_ref |
|------|---------|---------------|-------|--------------|
| 2026-10-29 | ISS-20261029-001 | 手设参数 | 本地 CLI 工作目录统一为应用缓存下的 `com.niko-buddy.app/cli-workspace`（Windows `%LOCALAPPDATA%`，macOS `~/Library/Caches`，其他 `$XDG_CACHE_HOME` 或 `~/.cache`）。claude / codex / gemini 创建失败即报错；cursor 代理尽力而为。gate target 同为该目录 | `src-tauri/src/commands/local_cli_config.rs` `ensure_cli_workspace_dir` |
| 2026-10-29 | ISS-20261029-002 | 裁决人 | 「隔离本地 CLI 配置」默认保持 false，不加 `--setting-sources ""`：中转 / API Key 用户把 env 与 base URL 放在 settings.json，强制关闭会断连。文案改为列明覆盖与不覆盖项；开关只对 Claude Code / Codex 显示 | `src/i18n/{zh,en}.json`、`llm-provider-widgets.tsx` |
| 2026-10-29 | ISS-20261029-003 | 手设参数 | Gemini 回退去掉 `--yolo`，依赖 headless ASK_USER→DENY；antigravity 分支不变 | `antigravity_cli.rs` 单测 3 个 |
| 2026-10-29 | ISS-20261029-004 | 手设参数 | npx 回退锁 `cursor-api-proxy@1.7.0`；托管代理强制 `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=true`、`MODE=ask`、`FORCE`/`APPROVE_MCPS`/`DSH_AUTO_MODE=false`；Unix 下这些值连同 HOST/PORT 与 cwd 写进 `$SHELL -l -c` 命令串（`exec env ...`），防 profile 覆盖 | `cursor_cli.rs` 单测 3 个 |
| 2026-10-29 | ISS-20261029-005 | 裁决人 | 掌舵人 2026-10-29 授权方案 1：本地 CLI 门控 target = `<专用工作目录>#req=<sha256 前 8 字节 hex>`，摘要为长度前缀的 provider、model 与请求内容（claude：各消息 role + content blocks JSON、isolate、json_schema；codex：prompt + isolate；antigravity：prompt）。不同请求不累计，相同请求 60s 内 3 次仍熔断。未选方案 2（调阈值）：只推迟误伤 | `local_cli_config.rs` `cli_gate_target`；`agent_gate.rs` 新测 |
| 2026-10-30 | ISS-20261029-006 | 裁决人 | 掌舵人 2026-10-30 授权自行收尾残余。门控 target 去掉工作目录绝对路径，改为 `cli-workspace/{provider}#req=<16hex>`。原因：旧 target 含用户名，用户名为 `QM` 或 `canon` 时命中 protected_prefix 的 `/QM/`、`/canon/` 子串，CLI 调用被硬拒。新 target 不含 `/` 开头的路径段，不会命中受保护前缀 | `local_cli_config.rs` `cli_gate_target`；`agent_gate.rs` `distinct_cli_requests_do_not_trip_loop_breaker` |
| 2026-10-30 | ISS-20261029-007 | 手设参数 | Claude transport 的重试次序号进门控摘要：`claude_gate_target(..., retry_attempt)`，键加 `retry=min(n, 3)`，前端 `SpawnPayload.retryAttempt` 取 `transportRetryAttempt`。快速失败的 429 按 0s/5s/≈22s 重发时三次落在不同键上，不再触发全局熔断。上限 3 等于 `CLAUDE_CLI_RETRY_DELAYS_MS` 长度。代价：键还含 isolate，真实前端每个请求最多 5 个键（isolate=false 的 attempt 0，加 isolate=true 的 attempt 0..3），伪造的调用方最多 4 × 2 = 8 个键、第 24 次调用才熔断。熔断本来挡不住故意改 prompt 的调用方，只是放宽了上限；22s 内对同一 prompt 连点 3 次重新生成仍会熔断（走的是 attempt 0），接受 | `claude_cli.rs` `CLAUDE_GATE_MAX_RETRY_ATTEMPT`、`claude_gate_target_covers_messages_isolation_and_schema`；`claude-cli-transport.spec.ts` 断言 isolate 重试 `[[0, false], [0, true]]`、429 退避重试 `[0, 1, 2, 3]` |
| 2026-10-30 | ISS-20261029-008 | 手设参数 | PATH 上的 `cursor-api-proxy` 只有 `package.json` 版本等于锁定的 `1.7.0` 时才用，否则走 `npx cursor-api-proxy@1.7.0`；没有 npx 时报错并提示 `npm i -g cursor-api-proxy@1.7.0`。版本读不到或不可解析按不匹配处理（失败即关）。只读 package.json，不执行代理 | `cursor_cli.rs` `choose_proxy_launcher`、`path_proxy_is_used_only_at_the_pinned_version` |
| 2026-10-30 | ISS-20261029-009 | 手设参数 | 缓存目录解析失败的分支抽成 `ensure_cli_workspace_dir_from(Option<PathBuf>)`，`None` 时返回 Err，claude / codex / gemini 照此失败即关 | `local_cli_config.rs` `cli_workspace_resolution_fails_closed` |
| 2026-10-29 | ISS-20261029-001..004 | 外部佐证引用 | Claude Code 对 cwd 内只读工具免审批；Gemini headless 把 ASK_USER 视为 DENY；cursor-api-proxy 1.7.0 env 默认值与「单次请求 mode 优先于 env」；Codex `--ignore-user-config` 跳过 config.toml 但登录态仍生效，`--ignore-rules` 跳过 execpolicy。Codex 对 AGENTS.md 的处理未核实，本条目不作断言 | 各上游官方文档 / 包源码，本轮核对 |

## 二、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261029-01 | ~~本地 CLI 的 gate target 按机器恒定，60s 内第 3 次调用触发全局 halt~~。**已偿还 2026-10-29**（ISS-20261029-005，方案 1） | — | 已偿还 |
| DEBT-20261029-02 | ~~PATH 上全局安装的 `cursor-api-proxy` 优先于锁定的 npx 版本，版本不受控~~。**已偿还 2026-10-30**（ISS-20261029-008，版本不等于 1.7.0 时改走 npx） | — | 已偿还 |

## 三、验证

- `cargo test --lib`：2026-10-29 为 464 passed；2026-10-30 收尾 R1–R4 后 466 passed / 0 failed / 2 ignored（独立复核实测一致）。R3 加 log 后复跑出现 6 个偶发失败（batch_replace / snapshot_timemachine / mcp_remote）：D5 新测 `distinct_cli_requests_do_not_trip_loop_breaker` 有意触发熔断却没清理进程级熔断态，后续用例按执行顺序被拒。已按同文件其他熔断用例的做法补 `ResumeAfterHalt` 清理，之后连续两次 466 passed / 0 failed / 2 ignored。
- Unix 分支：`cargo check --target x86_64-unknown-linux-gnu` 在本机因 `zstd-sys` 原生构建失败未能跑通；`unix_proxy_cmdline` 为平台无关函数，由单测覆盖，`#[cfg(unix)]` 调用处未在本机编译。
- `npx vitest run` 设置页 spec + 3 个 i18n spec：4 文件 59 passed（含新测 antigravity 卡片无隔离开关）。
- `npm run typecheck`（`tsc --build --force`）：0 错。
- `cargo fmt --check`：本轮改动的 7 个 Rust 文件无差异。2026-10-30 已把 `claude_cli_launch.rs`（`select_claude_cli_input_mode` 签名换行）与 `agent_gate.rs`（`pub use` 排序）格式化，无语义变化；`agent_gate.rs` 工作区保持 CRLF，`.gitattributes` 为 eol=lf，提交时规范为 LF。全 crate 其余 57 处 / 19 文件为既有差异（canon/、fs.rs、project.rs 等），未纳入。
- TS 侧：`claude-cli-transport.spec.ts` 断言隔离回退为 `[[0,false],[0,true]]`、退避重试为 `[0,1,2,3]`，并读取 `claude_cli.rs` 断言 `CLAUDE_GATE_MAX_RETRY_ATTEMPT` 等于最大退避序号，前后端上限不再只靠手工对齐。transport 4 文件 99 passed。
- D5 复现（修复前）：临时 `#[ignore]` 测试，前两次 proceed，第 3 次 `loop threshold reached; halted`，随后无关 User writeFile 也被拒；测试已删除。
- D5 修复后：`agent_gate::distinct_cli_requests_do_not_trip_loop_breaker` 6 次不同请求全部放行、无关 User 写入放行、相同请求第 3 次熔断；`cli_gate_target_keys_on_request_not_machine` 覆盖稳定性、各字段敏感性与长度前缀边界。三个调用点的摘要组装抽成纯函数 `claude_gate_target` / `codex_gate_target` / `antigravity_gate_target`，各有单测（claude 覆盖消息内容、role、条数、图片字节、isolate、schema，以及纯字符串与等价 text 块同键）。

## 四、残余风险（已知，未改）

- Codex `--sandbox read-only` 仍可读 cwd 外文件，属上游 sandbox 语义；专用目录只缩小默认范围。
- 应用托管的 cursor 代理会覆盖用户全局 `CURSOR_BRIDGE_MODE`；需要 agent 模式时须在单次请求里指定 mode。
- 开启隔离后 Claude Code 仍读 `~/.claude/settings.json` 与 CLAUDE.md，已写进文案。
- ~~D5 修复后，Claude transport 的重试计入同一门控键，三次尝试落在 60s 内会熔断~~。已由 ISS-20261029-007 处理：重试次序号进键。用户 22s 内对同一 prompt 连点 3 次重新生成仍会熔断，属有意保留。隔离回退重试的 isolate 不同，算不同键。
- Unix 分支（`#[cfg(unix)]`，含 cursor 代理 `$SHELL -l -c` 启动串）本机无法编译：`zstd-sys` 交叉构建失败。逻辑在平台无关函数里有单测，调用处需在 macOS / Linux CI 上编译确认。
- Antigravity / Gemini 卡片不显示隔离开关：spawn 路径没有 isolate 参数，显示了也不生效。
- 关闭隔离时，若 Claude 运行在无输出前以 `isolation_retry` 类错误失败，transport 会自动用隔离模式重试一次（既有行为，`claude-cli-transport.ts:671-678`）。

## 五、独立复核

- 第一次复核子代理中途失败，无结论。第二次（独立上下文、只读，限定 10 个文件 + 本文件）：无 blocker。
- major（已修）：`cursor_cli.rs` Unix 分支经 `$SHELL -l -c` 启动，login shell 在 `cmd.env` 之后读 `~/.zprofile` 等，profile 里的 `export CURSOR_BRIDGE_MODE=agent` 会覆盖强制值。修复：新增 `unix_proxy_cmdline`，在命令串内 `cd` 后 `exec env` 重设 HOST/PORT 与 5 个 chat-only 变量；新测 `unix_proxy_cmdline_reasserts_env_after_profile`。
- minor（未改，记录）：新测只覆盖目录 helper，未覆盖「缓存目录解析失败时 claude/codex/gemini 返回 Err」；`cli_workspace_is_never_under_shared_temp` 在 base 为 None 时静默通过。
- nit（已改）：en `localCliIsolationOff` 与 zh 对齐为 “your CLI login and all local config are used”。
- 复核确认：目录名与 `tauri.conf.json` identifier 一致；Codex 保留 `--skip-git-repo-check`；文案与 Claude/Codex 代码行为一致；gate protected_prefix 不命中缓存路径；spec 无状态泄漏。
- D5 复核（第三次，独立上下文、只读）：无 blocker；新 target 经 relative_to_root / protected_prefix / effective_decision 后裁决与改前一致；摘要编码单射、图片块确定序列化；其他 gate_authorize 调用方、审计 jsonl、halt.json 与 Resume 不受影响。
  - major（已修）：调用点无测试，改回旧 target 不会失败。修复：抽出三个 `*_gate_target` 纯函数并补单测。
  - major（未改，修复前已有，待掌舵人决定）：快速失败的可重试错误（如无 API key 时的 429）按 0s/5s/≈22s 重发相同请求，第 3 次触发全局熔断；用户 22s 内对同一 prompt 连点 3 次重新生成同理。候选：传输层重试不计入，或给 runCommand/Cli 单设阈值。
  - minor（未改）：protected_prefix 的 `/QM/`、`/canon/` 子串判定区分大小写；Windows 用户名恰为 `QM` 或 `canon` 时，专用工作目录路径会命中，CLI 调用被硬拒。来源是 D1 的目录迁移，与 #req 无关。
  - nit（未改）：json_schema 键序依赖 serde_json 特性，只会让计数偏少；大图会被额外序列化一次。
- 2026-10-30 残余收尾：上面「快速失败重试熔断」major 由 ISS-20261029-007 处理；`/QM/`、`/canon/` minor 由 ISS-20261029-006 处理；「缓存目录解析失败无测试」minor 由 ISS-20261029-009 处理；DEBT-20261029-02 偿还。
- R1–R4 复核（第四次，独立上下文、只读，2026-10-30）：无 blocker、无 major。实测 cargo 466 passed，transport + vertical-slice vitest 5 文件 110 passed。确认 R1 新 target 裁决与旧 target 相同（Allowed），只在用户名含 `QM`/`canon` 时由硬拒变为放行；R2 缺字段默认 0、非法值反序列化失败不 spawn、超大值收敛到 3；R3 只读 package.json、读不到版本失败即关；R4 三个调用方都在门控与 spawn 之前用 `?` 传播错误。
  - minor（已改）：本文件 L16 / 验证段的断言、测试数与 fmt 说明过时；R2 键数估算未计 isolate。已更正。
  - minor（已改）：PATH 上版本不符时静默改走 npx。已加 `log::warn!`（`cursor_cli.rs` `choose_proxy_launcher`）。
  - nit（已改）：前后端重试上限手工对齐。`claude-cli-transport.spec.ts` 读取 Rust 常量断言相等。
  - minor（未改，记录）：Unix 软链定位 package.json 的分支无测试（本机为 Windows，fixture shim 为普通文件）；R4 调用方传播无测试保护；`cli_workspace_is_never_under_shared_temp` 在 base 为 None 时静默通过。
  - nit（未改，接受）：版本检查与执行 shim 之间存在 TOCTOU，能改 PATH 目录者本可直接替换代理，版本检查定位为一致性检查而非完整性校验；npx 只锁顶层版本。
