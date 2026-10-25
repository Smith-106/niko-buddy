/**
 * asset-extraction-gap-panel.tsx — 「正文有、资产没有」的只读缺口面板。
 *
 * 续写 / 拆书共用：把「正文里已经出现、但资产库还没接」的人物与关系列出来，
 * 并给**可直接粘去草稿区**的补充建议（Draft-first：本面板不写任何文件）。
 */

import { useMemo } from "react"
import { FileSearch } from "lucide-react"

import {
  detectAssetExtractionGaps,
  type ExtractionGapInput,
  type ExtractionGapProjection,
} from "@/lib/novel"

export interface AssetExtractionGapPanelProps {
  /** 注入投影结果（测试可替换）。 */
  readonly projection?: ExtractionGapProjection
  /** 注入输入（未给 projection 时用于计算）。 */
  readonly input?: ExtractionGapInput
}

const EMPTY_INPUT: ExtractionGapInput = {
  chapterNumber: null,
  chapterText: "",
  characters: [],
  charactersLoaded: false,
  wikiCharacterNames: [],
  wikiLoaded: false,
}

export function AssetExtractionGapPanel({ projection, input }: AssetExtractionGapPanelProps) {
  const resolved = useMemo<ExtractionGapProjection>(
    () => projection ?? detectAssetExtractionGaps(input ?? EMPTY_INPUT),
    [input, projection],
  )

  const gapCount = resolved.gaps.length

  return (
    <section
      data-testid="asset-extraction-gap-panel"
      className="space-y-2 rounded-md border border-border p-3"
    >
      <header className="space-y-1">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <FileSearch className="h-4 w-4" />
          资产提取缺口（只读诊断）
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="asset-extraction-gap-scope">
          只列缺口、给草稿建议：本面板不建实体、不改资产。世界构建与场景没有结构化真源，一律 N/A
          —— 不猜实体，避免污染资产库。
        </p>
      </header>

      <p className="text-xs text-muted-foreground" data-testid="asset-extraction-gap-summary">
        正文识别到人物：<b className="text-foreground">{resolved.counts.mentionedCharacters}</b> 人 · wiki 人物实体：
        <b className="text-foreground">{resolved.counts.wikiCharacters}</b> · 角色状态：
        <b className="text-foreground">{resolved.counts.stateCharacters}</b> 人 · 缺口：
        {resolved.checked ? (
          <>
            <b className="text-foreground">{gapCount}</b> 条
          </>
        ) : (
          <>N/A（未装载 / 无正文，不显示 0）</>
        )}
      </p>

      {gapCount === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="asset-extraction-gap-empty"
        >
          暂无可判定的缺口（若上方 N/A 说明「未装载 / 无正文」，这行**不代表**资产已齐）。
        </p>
      ) : (
        <ul className="space-y-1" data-testid="asset-extraction-gap-list">
          {resolved.gaps.map((gap, index) => (
            <li
              key={`${gap.code}-${index}`}
              // 序号按 code 各自计数：断言「人物缺口 0 号」「关系缺口 0 号」不受另一类插入影响。
              data-testid={`asset-extraction-gap-${gap.code}-${
                resolved.gaps.slice(0, index).filter((item) => item.code === gap.code).length
              }`}
              className="rounded border border-info/40 bg-info/5 p-1.5 text-xs text-info"
            >
              <b>{gap.code}</b> · {gap.subject}
              <div className="text-xs text-muted-foreground">{gap.detail}</div>
              <div className="text-xs text-muted-foreground">证据：{gap.evidence}</div>
            </li>
          ))}
        </ul>
      )}

      {resolved.proposals.length > 0 ? (
        <details className="text-xs text-muted-foreground" data-testid="asset-extraction-gap-proposals">
          <summary className="cursor-pointer text-foreground">
            补充建议（{resolved.proposals.length} 条，粘去草稿区后 accept 才会生效）
          </summary>
          <ul className="mt-1 space-y-1">
            {resolved.proposals.map((proposal, index) => (
              <li
                key={`${proposal.kind}-${index}`}
                data-testid={`asset-extraction-proposal-${proposal.kind}-${index}`}
              >
                <b className="text-foreground">{proposal.title}</b>
                <div>{proposal.body}</div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="asset-extraction-gap-na">
        <li className="font-medium text-foreground">N/A 说明</li>
        {resolved.na.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )
}
