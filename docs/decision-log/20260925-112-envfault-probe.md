# #112 第十七轮 RV-125/RV-132 ENV-FAULT 负向故障注入证据

日期：2026-09-25 ｜ HEAD 基线：`dd211789`（R1 窗口 -50）｜ 注入方式：临时复制脚本到
`.faultprobe/`（已删除，工作树干净），注入 `throw new Error("injected-env-fault-probe*")`
后运行，断言三条件：① 退出码=2 ② 输出含 `ENV-FAULT` ③ 故障点前无 `PASS` 令牌。

## 探针结果（全部通过）

| 脚本 | 注入点 | EXIT | 输出 | PASS 令牌 |
|------|--------|------|------|-----------|
| goal-accept-r1r2.mjs | execSync 前 throw | 2 | `ENV-FAULT: injected-env-fault-probe` | 0 行 |
| goal-accept-r3r4.mjs | mustContain 前 throw | 2 | `ENV-FAULT: injected-env-fault-probe-r34` | 0 行 |
| goal-accept-r567.mjs | read 前 throw | 2 | `ENV-FAULT: injected-env-fault-probe-r567` | 0 行 |

附加：r3r4 断言失败路径（不存在文件）仍走 `FAIL` + exit=1（与 ENV-FAULT/exit=2 分层，
RV-133 关闭：`fail()` 抛错路径独立，catch 仅兜环境/IO 异常）。

## 结论

- RV-125 / RV-132 关闭条件满足：ENV-FAULT 哨兵 fail-closed 有行为证据（非仅 happy-path）。
- RV-133 关闭：FAIL（exit 1）与 ENV-FAULT（exit 2）语义分层已实证。
- RV-135 回溯：本证据运行均为 full-config（hub 根正常工作区），非 degraded-config。
