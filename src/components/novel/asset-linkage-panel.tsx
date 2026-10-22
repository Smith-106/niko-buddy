/**
 * asset-linkage-panel.tsx — 资产联动一致性（**只读诊断**）面板。
 *
 * 挂在既有资产库视图里，不新增导航页、不自动修复：产物是带 contentHash 的不可变
 * 快照，改写只能走既有迁移入口。这里只把「谁陈旧 / 哪条事实没回填 / 图谱边缺多」列清，
 * 并明确写出哪些面 N/A（没有数据 ≠ 不一致）。
 */

import { useMemo } from "react"
import { Link2 } from "lucide-react"

import {
  auditAssetLinkage,
  type AssetLinkageAuditInput,
  type AssetLinkageAuditResult,
} from "@/lib/novel"

export interface AssetLinkagePanelProps {
  /** 注入审计结果（测试可替换）。 */
  readonly result?: AssetLinkageAuditResult
  /** 注入输入（未给 result 时用于计算）。 */
  readonly input?: AssetLinkageAuditInput
}

export function AssetLinkagePanel({ result, input }: AssetLinkagePanelProps) {
  const resolved = useMemo<AssetLinkageAuditResult>(
    () =>
      result ??
      auditAssetLinkage(
        // 注意：不传 snapshotRelationLines = 「本页未装载，未检查」；传 [] 才是「已装载且零条」。
        input ?? { characters: [], charactersLoaded: false, relationshipArtifact: null },
      ),
    [input, result],
  )

  const conflictCount = resolved.conflicts.length
  const unloaded = resolved.derivedEdgeCount === null

  return (
    <section
      data-testid="asset-linkage-panel"
      className="space-y-2 rounded-md border border-border p-3"
    >
      <header className="space-y-1">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <Link2 className="h-4 w-4" />
          资产联动一致性（只读诊断）
        </h3>
        <p className="text-[10px] text-muted-foreground" data-testid="asset-linkage-scope">
          只比对、不改写：资产产物带 contentHash 是不可变快照，重建只能走既有迁移入口。关系语义一律
          unknown，不猜种类。
        </p>
      </header>

      <p className="text-[11px] text-muted-foreground" data-testid="asset-linkage-summary">
        角色状态关系边：
        <b className="text-foreground">
          {resolved.derivedEdgeCount === null ? (
            <>
              不适用（未装载）
              <span className="sr-only">N/A（未装载）</span>
            </>
          ) : `${resolved.derivedEdgeCount} 条`}
        </b>{" "}
        · 已存产物：
        <b className="text-foreground">
          {resolved.artifactEdgeCount === null ? (
            <>
              不适用（未迁移）
              <span className="sr-only">N/A（未迁移）</span>
            </>
          ) : `${resolved.artifactEdgeCount} 条`}
        </b>{" "}
        · 冲突：<b className="text-foreground">{conflictCount}</b> 条
      </p>

      {unloaded ? (
        <p className="text-[11px] text-muted-foreground" data-testid="asset-linkage-unloaded">
          角色状态尚未装载：比对面整段不适用，不能当成「暂无不一致」。
        </p>
      ) : conflictCount === 0 ? (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-400" data-testid="asset-linkage-clean">
          暂未发现联动不一致（缺失面见下方不适用说明，不要当成「全部一致」）。
        </p>
      ) : (
        <ul className="space-y-1" data-testid="asset-linkage-conflicts">
          {resolved.conflicts.map((conflict, index) => (
            <li
              key={`${conflict.code}-${index}`}
              data-testid={`asset-linkage-conflict-${conflict.code}-${index}`}
              className="rounded border border-amber-500/40 bg-amber-500/5 p-1.5 text-[11px] text-amber-800 dark:text-amber-300"
            >
              <b>{conflict.code}</b> · {conflict.left}
              {conflict.right ? ` → ${conflict.right}` : ""}
              <div className="text-[10px] text-muted-foreground">{conflict.detail}</div>
            </li>
          ))}
        </ul>
      )}

      <ul className="space-y-0.5 text-[10px] text-muted-foreground" data-testid="asset-linkage-na">
        <li className="font-medium text-foreground">
          不适用与非冲突说明<span className="sr-only">N/A</span>
        </li>
        {resolved.na.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )
}
