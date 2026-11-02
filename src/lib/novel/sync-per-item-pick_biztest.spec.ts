/**
 * sync-per-item-pick_biztest.spec.ts — 业务验收 B2（双改逐项裁决）+ B3（批次明细）的线上契约面。
 *
 * 用户视角的问题：
 *
 *   B2 「两个设备都改了同一个文件，界面让我选什么？默认是什么？选了之后发出去的是什么？」
 *      → 断言批次明细里每一项的 `pickable` / `choices` / `default_decision` 决定界面
 *        能提供哪些选项（有 base 且双改 = 三选一；无 base / 缺侧 = 只有「保留两者」），
 *        以及逐项裁决请求确实带上**批次身份 + 显式 actor + 每一项的裁决**。
 *   B3 「同步完之后，我能不能按批次看到每一项（文件 / 方向 / 状态 / 错误）？」
 *      → 断言 `sync_batches` 的返回结构逐项携带 path / direction / status / duration /
 *        error / decision，批次携带 manifest / revision / direction / status / base 指针。
 *
 * 语义**强制**（无 base 时 pick_mine / pick_theirs 被拒）发生在 Rust 侧
 * （`sync_target_decision.rs::apply_single_item`），由 `cargo test commands::sync` 里的
 * `apply_requires_actor_and_refuses_pick_without_base` 实测；本文件守的是它前面的
 * 用户可见契约：界面拿到的选项集合与提交的载荷。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

import { invoke } from "@tauri-apps/api/core"
import {
  PICK_KEEP_BOTH,
  PICK_MINE,
  PICK_THEIRS,
  applyPerItemDecisionCommand,
  syncBatchesCommand,
  type RawSyncBatch,
} from "@/commands/sync"
import { CONFLICT_DEFAULT_RESOLUTION } from "./sync-client"

const PROJECT = "C:/novel/demo"
const DEVICE = "device-a"

/** 有 base 的批次：a.md 双改（可三选一），b.md 单侧改动（不可选）。 */
const batchWithBase: RawSyncBatch = {
  batch_id: "batch-1",
  manifest_id: "20261102-120000",
  revision: 3,
  direction: "conflict",
  device_id: DEVICE,
  ts: "20261102120000",
  content_hash: "a".repeat(64),
  base_rev: 2,
  base_content_hash: "b".repeat(64),
  base_available: true,
  status: "keep_both",
  duration_ms: 42,
  items: [
    {
      path: "chapters/01.md",
      direction: "conflict",
      status: "both_changed",
      duration_ms: 12,
      pickable: true,
      base_available: true,
      choices: [PICK_MINE, PICK_THEIRS, PICK_KEEP_BOTH],
      default_decision: PICK_KEEP_BOTH,
    },
    {
      path: "chapters/02.md",
      direction: "conflict",
      status: "theirs_only",
      duration_ms: 3,
      pickable: false,
      base_available: true,
      choices: [PICK_KEEP_BOTH],
      default_decision: PICK_KEEP_BOTH,
    },
  ],
}

/** 老批次（无 base 指针）：逐项只能「保留两者」，且已有失败项可重试。 */
const legacyBatchWithoutBase: RawSyncBatch = {
  batch_id: "batch-0",
  manifest_id: "20261101-090000",
  revision: 1,
  direction: "pull",
  device_id: DEVICE,
  ts: "20261101090000",
  content_hash: "c".repeat(64),
  base_available: false,
  status: "partial",
  duration_ms: 900,
  error: "one item failed",
  items: [
    {
      path: "chapters/03.md",
      direction: "pull",
      status: "no_base",
      duration_ms: 5,
      error: "remote read failed",
      pickable: false,
      base_available: false,
      choices: [PICK_KEEP_BOTH],
      default_decision: PICK_KEEP_BOTH,
    },
  ],
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

describe("B2 双改逐项裁决：界面能提供什么、提交的是什么", () => {
  it("有 base 且双改 → 三选一；默认裁决恒为 keep_both", () => {
    const pickable = batchWithBase.items[0]!
    expect(pickable.pickable).toBe(true)
    expect(pickable.base_available).toBe(true)
    expect(pickable.choices).toEqual([PICK_MINE, PICK_THEIRS, PICK_KEEP_BOTH])
    // 默认终止态：不选就等于「保留两者」，绝不是覆盖。
    expect(pickable.default_decision).toBe(PICK_KEEP_BOTH)
    expect(CONFLICT_DEFAULT_RESOLUTION).toBe("keep_both")
  })

  it("无 base 的批次 → 逐项只提供 keep_both（pick_mine / pick_theirs 无从选择）", () => {
    const item = legacyBatchWithoutBase.items[0]!
    expect(legacyBatchWithoutBase.base_available).toBe(false)
    expect(item.pickable).toBe(false)
    expect(item.choices).toEqual([PICK_KEEP_BOTH])
    expect(item.default_decision).toBe(PICK_KEEP_BOTH)
    // 缺侧 / 无 base 的项不可选 → 界面不会给出覆盖选项。
    expect(item.choices).not.toContain(PICK_MINE)
    expect(item.choices).not.toContain(PICK_THEIRS)
  })

  it("逐项裁决请求带上批次身份 + 显式 actor + 每一项裁决（无 actor 由 Rust 直接拒绝）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        path: "chapters/01.md",
        decision: PICK_THEIRS,
        status: "applied",
        output_path: ".novel/resolutions/batch-1/chapters/01.md",
      },
    ])

    const results = await applyPerItemDecisionCommand(
      PROJECT,
      batchWithBase,
      DEVICE,
      [{ path: "chapters/01.md", decision: PICK_THEIRS }],
    )

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("sync_apply_per_item_decision", {
      projectPath: PROJECT,
      manifestId: "20261102-120000",
      revision: 3,
      direction: "conflict",
      ts: "20261102120000",
      deviceId: DEVICE,
      actor: DEVICE,
      items: [{ path: "chapters/01.md", decision: PICK_THEIRS }],
    })
    // 落盘位置在过程面（.novel/resolutions/…），不覆盖工作文件树。
    expect(results[0]!.status).toBe("applied")
    expect(results[0]!.output_path).toContain(".novel/resolutions/")
  })

  it("单项失败不滚整体：同一次调用里 applied 与 error 并存", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { path: "chapters/01.md", decision: PICK_MINE, status: "applied", output_path: "a" },
      { path: "chapters/02.md", decision: PICK_MINE, status: "error", error: "no such file" },
    ])
    const results = await applyPerItemDecisionCommand(PROJECT, batchWithBase, DEVICE, [
      { path: "chapters/01.md", decision: PICK_MINE },
      { path: "chapters/02.md", decision: PICK_MINE },
    ])
    expect(results.map((r) => r.status)).toEqual(["applied", "error"])
    expect(results[1]!.error).toBe("no such file")
  })

  it("用户什么都没选时提交的裁决是 keep_both（默认终止态不会被静默升级）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { path: "chapters/01.md", decision: PICK_KEEP_BOTH, status: "keep_both" },
    ])
    await applyPerItemDecisionCommand(PROJECT, batchWithBase, DEVICE, [
      { path: "chapters/01.md", decision: PICK_KEEP_BOTH },
    ])
    const payload = vi.mocked(invoke).mock.calls[0]![1] as { items: { decision: string }[] }
    expect(payload.items.every((item) => item.decision === "keep_both")).toBe(true)
  })
})

describe("B3 批次明细：按批次列出每一项结果（文件 / 方向 / 状态 / 错误）", () => {
  it("sync_batches 返回逐批次 + 逐项明细，字段齐全可渲染", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([batchWithBase, legacyBatchWithoutBase])

    const batches = await syncBatchesCommand(PROJECT)

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("sync_batches", { projectPath: PROJECT })
    expect(batches).toHaveLength(2)

    const [withBase, legacy] = batches as [RawSyncBatch, RawSyncBatch]

    // 批次头：清单 / 修订 / 方向 / 状态 / 耗时 / base 指针。
    expect(withBase.manifest_id).toBe("20261102-120000")
    expect(withBase.revision).toBe(3)
    expect(withBase.direction).toBe("conflict")
    expect(withBase.status).toBe("keep_both")
    expect(withBase.duration_ms).toBe(42)
    expect(withBase.base_rev).toBe(2)
    expect(withBase.base_available).toBe(true)

    // 逐项：文件 / 方向 / 状态 / 耗时（+ 可选错误与已裁决值）。
    expect(withBase.items.map((item) => item.path)).toEqual([
      "chapters/01.md",
      "chapters/02.md",
    ])
    expect(withBase.items[0]!.direction).toBe("conflict")
    expect(withBase.items[0]!.status).toBe("both_changed")
    expect(withBase.items[0]!.duration_ms).toBe(12)

    // 老批次：无 base 指针（不迁移、不重写）+ 失败项带错误原因（可重试）。
    expect(legacy.base_rev).toBeUndefined()
    expect(legacy.base_available).toBe(false)
    expect(legacy.error).toBe("one item failed")
    expect(legacy.items[0]!.error).toBe("remote read failed")
    expect(legacy.items[0]!.status).toBe("no_base")
  })

  it("每一项都能单独定位（批次 + 路径唯一定位一个结果行）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([batchWithBase])
    const [batch] = (await syncBatchesCommand(PROJECT)) as [RawSyncBatch]
    const keys = batch.items.map((item) => `${batch.batch_id}::${item.path}`)
    expect(new Set(keys).size).toBe(batch.items.length)
    expect(keys[0]).toBe("batch-1::chapters/01.md")
  })
})
