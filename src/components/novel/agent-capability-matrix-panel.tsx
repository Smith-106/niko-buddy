/**
 * agent-capability-matrix-panel.tsx — agent 角色 × 技能覆盖矩阵（只读）。
 *
 * 回答「这本书/这个场景该给哪个 agent 配哪些技能，还缺什么」。
 * 不生成技能、不改技能库、不决定模型路由；未装载技能库时整段 N/A。
 */

import { useMemo } from "react"
import { Users } from "lucide-react"

import {
  projectAgentCapabilityMatrix,
  type AgentCapabilityMatrixInput,
  type AgentCapabilityMatrixProjection,
} from "@/lib/novel"

export interface AgentCapabilityMatrixPanelProps {
  /** 注入投影结果（测试可替换）。 */
  readonly projection?: AgentCapabilityMatrixProjection
  /** 注入输入（未给 projection 时用于计算）。 */
  readonly input?: AgentCapabilityMatrixInput
}

const EMPTY_INPUT: AgentCapabilityMatrixInput = { skills: [], roles: [], skillsLoaded: false }

/**
 * 技能名清单可能上百条（技能库真实规模）：文本只列前 N 项，全量放 `title`。
 * 这样面板能塞进侧栏而不把列表挤爆，也不至于「看着像全量其实截断」。
 */
const NAME_LIMIT = 3

function summarizeNames(names: readonly string[]): { text: string; title: string } {
  if (names.length === 0) return { text: "不适用（没有对应技能）", title: "" }
  if (names.length <= NAME_LIMIT) return { text: names.join("、"), title: names.join("、") }
  return {
    text: `${names.slice(0, NAME_LIMIT).join("、")} 等 ${names.length} 项`,
    title: names.join("、"),
  }
}

export function AgentCapabilityMatrixPanel({
  projection,
  input,
}: AgentCapabilityMatrixPanelProps) {
  const resolved = useMemo<AgentCapabilityMatrixProjection>(
    () => projection ?? projectAgentCapabilityMatrix(input ?? EMPTY_INPUT),
    [input, projection],
  )

  const { counts } = resolved

  return (
    <section
      data-testid="agent-capability-panel"
      className="space-y-2 rounded-md border border-border p-3"
    >
      <header className="space-y-1">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <Users className="h-4 w-4" />
          Agent 能力矩阵（角色 × 技能）
        </h3>
        <p className="text-[10px] text-muted-foreground" data-testid="agent-capability-scope">
          能力 = 角色声明的类型/阶段标记 ∩ 技能声明的标记（复用技能库既有 kinds/stages）。
          本面板不生成技能、不改技能库、不决定模型路由。
        </p>
      </header>

      <p className="text-[11px] text-muted-foreground" data-testid="agent-capability-summary">
        {resolved.skillsLoaded ? (
          <>
            角色：<b className="text-foreground">{counts.roles}</b> · 技能：
            <b className="text-foreground">{counts.skills}</b> · 被覆盖角色：
            <b className="text-foreground">{counts.coveredRoles}</b> · 无人覆盖能力：
            <b className="text-foreground">{resolved.missingCapabilities.length}</b> · 无人需要技能：
            <b className="text-foreground">{resolved.unusedSkills.length}</b>
          </>
        ) : (
          <>
            技能库未装载：覆盖结论整段不适用（不显示 0，避免把「没读到」读成「零覆盖」）。
            <span className="sr-only">N/A</span>
          </>
        )}
      </p>

      {resolved.rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="agent-capability-empty">
          没有角色定义（不是「不需要技能」，见下方不适用说明）。
        </p>
      ) : (
        <ul className="space-y-1" data-testid="agent-capability-rows">
          {resolved.rows.map((row) => (
            <li
              key={row.roleId}
              data-testid={`agent-capability-row-${row.roleId}`}
              className={
                !resolved.skillsLoaded || row.matchedSkills.length > 0
                  ? "rounded border border-border p-1.5 text-[11px]"
                  : "rounded border border-amber-500/40 bg-amber-500/5 p-1.5 text-[11px] text-amber-800 dark:text-amber-300"
              }
            >
              <b>{row.label}</b>
              <div
                className="text-[10px] text-muted-foreground"
                title={summarizeNames(row.matchedSkills).title}
              >
                可用技能：
                {resolved.skillsLoaded ? (
                  summarizeNames(row.matchedSkills).text
                ) : (
                  <>
                    不适用（技能库未装载）
                    <span className="sr-only">N/A（技能库未装载）</span>
                  </>
                )}
              </div>
              {row.missingCapabilities.length > 0 ? (
                <div
                  className="text-[10px] text-amber-700 dark:text-amber-400"
                  data-testid={`agent-capability-missing-${row.roleId}`}
                >
                  缺口：{row.missingCapabilities.join("、")}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {resolved.missingCapabilities.length > 0 ? (
        <p
          className="text-[11px] text-amber-800 dark:text-amber-300"
          data-testid="agent-capability-global-missing"
        >
          全角色合起来仍无人覆盖：{resolved.missingCapabilities.join("、")}
        </p>
      ) : null}

      {resolved.unusedSkills.length > 0 ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="agent-capability-unused"
          title={summarizeNames(resolved.unusedSkills).title}
        >
          有技能但无角色声明需要（冗余候选，不是错误）：{summarizeNames(resolved.unusedSkills).text}
        </p>
      ) : null}

      <ul className="space-y-0.5 text-[10px] text-muted-foreground" data-testid="agent-capability-na">
        <li className="font-medium text-foreground">
          不适用说明<span className="sr-only">N/A</span>
        </li>
        {resolved.na.length === 0 ? <li>无</li> : null}
        {resolved.na.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )
}
