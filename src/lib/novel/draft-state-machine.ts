/**
 * P13 Draft-first 草稿状态机
 *
 * 状态流转: pending → ready → accepted/rejected → superseded
 * Rejected 可重新 Submit 回到 pending
 */

/** 草稿状态枚举 */
export enum DraftStatus {
  Pending = "pending",
  Ready = "ready",
  Accepted = "accepted",
  Rejected = "rejected",
  Superseded = "superseded",
}

/** 草稿事件枚举 */
export enum DraftEvent {
  Submit = "submit",
  Approve = "approve",
  Reject = "reject",
  Supersede = "supersede",
}

/** 状态转换表: Map<DraftStatus, Map<DraftEvent, DraftStatus>> */
const TRANSITION_TABLE: Map<DraftStatus, Map<DraftEvent, DraftStatus>> = new Map([
  [DraftStatus.Pending, new Map([
    [DraftEvent.Submit, DraftStatus.Ready],
  ])],
  [DraftStatus.Ready, new Map([
    [DraftEvent.Approve, DraftStatus.Accepted],
    [DraftEvent.Reject, DraftStatus.Rejected],
  ])],
  [DraftStatus.Accepted, new Map([
    [DraftEvent.Supersede, DraftStatus.Superseded],
  ])],
  [DraftStatus.Rejected, new Map([
    [DraftEvent.Submit, DraftStatus.Pending],
  ])],
  // Superseded 是终态，无法转换
  [DraftStatus.Superseded, new Map()],
])

/** 转换错误 */
export class DraftTransitionError extends Error {
  constructor(
    public readonly current: DraftStatus,
    public readonly event: DraftEvent,
    message?: string,
  ) {
    super(message ?? `Invalid transition: ${current} + ${event}`)
    this.name = "DraftTransitionError"
  }
}

/** 草稿状态机 */
export class DraftStateMachine {
  /**
   * 验证转换是否合法
   */
  static validateTransition(current: DraftStatus, event: DraftEvent): boolean {
    const transitions = TRANSITION_TABLE.get(current)
    if (!transitions) return false
    return transitions.has(event)
  }

  /**
   * 执行状态转换
   * @throws DraftTransitionError if transition is invalid
   */
  static transition(current: DraftStatus, event: DraftEvent): DraftStatus {
    if (!DraftStateMachine.validateTransition(current, event)) {
      throw new DraftTransitionError(current, event)
    }
    return TRANSITION_TABLE.get(current)!.get(event)!
  }

  /**
   * 追溯 superseded 链
   * @param draftId 当前草稿 ID
   * @param snapshots 快照列表（含 supersedesChain 或 supersedes 字段）
   * @returns 从当前到根的 superseded 链（含当前 draftId）
   */
  static getSupersededChain(
    draftId: string,
    snapshots: Array<{ snapshotId?: string; supersedes?: string; supersedesChain?: string[] }>,
  ): string[] {
    const chain: string[] = [draftId]
    const snapshotMap = new Map(
      snapshots.map(s => [s.snapshotId ?? "", s] as const),
    )

    let currentId = draftId
    const visited = new Set<string>()
    // 最多追溯 50 层，防止循环
    while (currentId && !visited.has(currentId) && chain.length < 50) {
      visited.add(currentId)
      const snapshot = snapshotMap.get(currentId)
      if (!snapshot?.supersedes) break
      chain.push(snapshot.supersedes)
      currentId = snapshot.supersedes
    }

    return chain
  }

  /**
   * 获取所有可用的后续状态
   */
  static getNextStatuses(current: DraftStatus): DraftStatus[] {
    const transitions = TRANSITION_TABLE.get(current)
    if (!transitions) return []
    return Array.from(transitions.values())
  }

  /**
   * 获取当前状态可触发的事件
   */
  static getAvailableEvents(current: DraftStatus): DraftEvent[] {
    const transitions = TRANSITION_TABLE.get(current)
    if (!transitions) return []
    return Array.from(transitions.keys())
  }
}
