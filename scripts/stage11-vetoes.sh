#!/usr/bin/env bash
# 阶段 11：硬否决 + 五项架构不变量 逐项取证（只读；作用域严格限定在 QMAI 内）
cd "C:/Users/niko/Desktop/工作目录/niko-hub/QMAI" || exit 1

count() { # count <pattern> <paths...>
  local out
  out=$(rg -c --no-messages "$1" "${@:2}" 2>/dev/null | wc -l)
  echo "$out"
}

echo "== 硬否决 =="
printf 'V1 marketplace_ (src-tauri/src + src/lib) ... %s\n' "$(count 'marketplace_' src-tauri/src src/lib)"
printf 'V1b 可执行扩展名导入拒绝（skill-pack 白名单）... %s\n' "$(rg -c 'NBSKILL_PACK_EXTENSION' src/lib/novel/skill-pack/pack-format.ts 2>/dev/null || echo 0)"
printf 'V2 snapshots @ multi_draft.rs（文件是否存在）... %s\n' "$(rg --files src-tauri/src 2>/dev/null | rg -c 'multi_draft' || echo 0)"
printf 'V3 file_sync @ sync_target.rs ... %s\n' "$(rg -c 'file_sync' src-tauri/src/commands/sync_target.rs 2>/dev/null || echo 0)"
printf 'V3b file_sync.rs 仍独立存在 ... %s\n' "$(rg --files src-tauri/src | rg -c 'commands/file_sync.rs' || echo 0)"
printf 'V4 openxz.cn|kilo.ai (src-tauri/src + src/lib) ... %s\n' "$(count 'openxz\.cn|kilo\.ai' src-tauri/src src/lib)"

echo
echo "== INV-1 status.json 唯一真源（无第二份会话状态文件）=="
printf '  新模块引用 status.json ... %s\n' "$(rg -c 'status\.json' src-tauri/src/batch_replace.rs src-tauri/src/pdf_export.rs src-tauri/src/mcp_remote.rs src-tauri/src/app_lock.rs src-tauri/src/credential_vault.rs 2>/dev/null | wc -l)"
printf '  可疑第二状态文件（session_state|novel_state|session-status）... %s\n' "$(count 'session_state\.json|novel_state\.json|session-status\.json' src-tauri/src src/lib)"
printf '  projection 状态仍走既有 ledger ... %s\n' "$(rg -c 'projection-status' src-tauri/src/batch_replace.rs 2>/dev/null || echo 0)"

echo
echo "== INV-2 门控优先级不位移 =="
rg -n 'P0|P1|P2' src/lib/novel/rerank-rubric.ts | rg -c 'consistency|anti_ai|quality|0\.5|0\.3|0\.2' | sed 's/^/  rerank-rubric 权重证据行数: /'
printf '  六维顺序单一来源 ... %s\n' "$(rg -c 'SIX_REVIEW_DIMENSION_ORDER' src/lib/novel/rerank-rubric.ts 2>/dev/null || echo 0)"
printf '  gate 破坏性操作表含 batchReplace ... %s\n' "$(rg -c '"batchReplace"' src-tauri/src/agent_gate.rs 2>/dev/null || echo 0)"

echo
echo "== INV-3 只增不覆 + 冲突留副本 =="
printf '  canon 归档模块 ... %s\n' "$(rg --files src-tauri/src/canon | rg -c 'archive.rs' || echo 0)"
printf '  批量替换草稿先行（DRAFTS_ROOT）... %s\n' "$(rg -c 'DRAFTS_ROOT' src-tauri/src/batch_replace.rs 2>/dev/null || echo 0)"
printf '  技能包导入写用户技能配置（不改既有）... %s\n' "$(rg -c 'USER_SKILL_CONFIG_FILE' src/lib/novel/skill-pack/pack-import.ts 2>/dev/null || echo 0)"

echo
echo "== INV-4 无新评分器 =="
printf '  trust-authority 复用 trust-grader ... %s\n' "$(rg -c 'trust-grader' src/lib/novel/trust-authority.ts 2>/dev/null || echo 0)"
printf '  rag-trust-audit 复用 trust-grader ... %s\n' "$(rg -c 'trust-grader' src/lib/novel/rag-trust-audit.ts 2>/dev/null || echo 0)"
printf '  可疑新权重常量（NEW_WEIGHT|SCORE_WEIGHTS|newGrader）... %s\n' "$(count 'NEW_WEIGHT|SCORE_WEIGHTS|newGrader' src/lib/novel src-tauri/src)"

echo
echo "== INV-5 外部输入带 trust_level + provenance =="
printf '  技能包 trustLevel 字段 ... %s\n' "$(rg -c 'trustLevel' src/lib/novel/skill-pack/pack-format.ts 2>/dev/null || echo 0)"
printf '  MCP 远端负载 origin/audit_pending ... %s\n' "$(rg -c 'audit_pending|origin' src-tauri/src/mcp_remote.rs 2>/dev/null || echo 0)"
printf '  MCP 前端审计决议 ... %s\n' "$(rg -c 'auditRemotePayload' src/lib/mcp/remote-transport.ts 2>/dev/null || echo 0)"
