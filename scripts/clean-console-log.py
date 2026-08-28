# -*- coding: utf-8 -*-
"""v2.8 Release Gate P1 修复：按共识清单删除调试 console.log。
DELETE 74 处 + DOWNGRADE 1 处（embedding.ts:511 -> console.warn）。
多行调用按括号平衡扩展删除。行号降序处理避免漂移。"""
import io, sys

# (file, [line numbers to DELETE]) — 行号 1-based，来自三模型共识清单（ds/hy3 一致）
DELETE_PLAN = {
    "src/lib/search.ts": [233, 262, 265, 268, 272, 273, 297, 305, 352, 360, 387, 393, 398, 412, 469, 481],
    "src/lib/ingest.ts": [311, 339, 342, 344, 364, 399, 433, 435, 437, 492, 520, 1356, 1359, 1401, 1439],
    "src/lib/ingest-queue.ts": [220, 261, 270, 309, 451, 537, 566],
    "src/lib/dedup-queue.ts": [269, 316, 334],
    "src/lib/embedding.ts": [519, 651],
    "src/lib/novel/chapter-ingest.ts": [593, 607, 686],
    "src/components/search/search-view.tsx": [96, 100, 195, 197, 214, 219, 226, 349],
    "src/components/novel/book-analysis-view.tsx": [292, 643, 645],
    "src/components/novel/book-analysis-result-viewer.tsx": [261, 264, 272, 285, 293, 310, 323, 906, 907, 930, 931],
    "src/components/settings/sections/saved-models-manager.tsx": [124, 163],
    "src/lib/sweep-reviews.ts": [461],
    "src/lib/ingest-cache.ts": [80],
    "src/components/project/welcome-screen.tsx": [42],
    "src/components/chat/chat-message.tsx": [464],
}

# (file, line, replacement) — DOWNGRADE
DOWNGRADE_PLAN = [
    ("src/lib/embedding.ts", 511, '      console.warn(`[Embedding] Indexed nothing for "${pageId}" — ${chunks.length - dedupedChunks} chunks failed, ${dedupedChunks} deduped. See getLastEmbeddingError().`)'),
]

def find_statement_end(lines, start_idx):
    """从 start_idx 开始，括号平衡找到语句结束行（含 console.log( 未闭合的多行调用）。"""
    depth = 0
    for i in range(start_idx, len(lines)):
        line = lines[i]
        depth += line.count("(") - line.count(")")
        if depth <= 0 and i > start_idx:
            return i
        if depth <= 0 and i == start_idx:
            # 单行语句：检查是否以 ; 或 ) 结尾（可能无分号）
            stripped = line.rstrip()
            if stripped.endswith(";") or stripped.endswith(")") or stripped.endswith("}"):
                return i
            # 单行但未闭合（如 console.log("x") 无分号）——保守：仅删本行
            return i
    return start_idx

total_deleted = 0
for path, lines_to_delete in DELETE_PLAN.items():
    with io.open(path, encoding="utf-8") as f:
        lines = f.readlines()
    # 行号降序处理
    for ln in sorted(lines_to_delete, reverse=True):
        idx = ln - 1
        if idx >= len(lines):
            print(f"WARN {path}:{ln} out of range")
            continue
        content = lines[idx]
        if "console.log" not in content:
            print(f"WARN {path}:{ln} not console.log: {content.strip()[:60]}")
            continue
        end_idx = find_statement_end(lines, idx)
        # 删除 idx..end_idx
        del lines[idx:end_idx + 1]
        total_deleted += 1
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.writelines(lines)
    print(f"{path}: {len(lines_to_delete)} statements removed")

# DOWNGRADE
for path, ln, replacement in DOWNGRADE_PLAN:
    with io.open(path, encoding="utf-8") as f:
        lines = f.readlines()
    idx = ln - 1
    if "console.log" not in lines[idx]:
        print(f"WARN DOWNGRADE {path}:{ln} not console.log: {lines[idx].strip()[:60]}")
        continue
    lines[idx] = replacement + "\n"
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.writelines(lines)
    print(f"{path}:{ln} downgraded to console.warn")

print(f"TOTAL deleted: {total_deleted}")
