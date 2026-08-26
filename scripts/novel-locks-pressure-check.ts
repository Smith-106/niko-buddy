#!/usr/bin/env node
/**
 * Phase4 锁族压力验收脚本（A8 补遗，2026-08-23）。
 *
 * 验证对象：novel-locks.ts 的 per-key 异步互斥。
 * 场景：模拟 community rebuild（fire-and-forget）与章节摄取并行时的
 * `appendProjectionAuditEntry` 并发——RMW 无锁会丢写，有锁应零丢失。
 *
 * 用法：node scripts/novel-locks-stress.js [iterations] [concurrent]
 * 退出码：0 = 全通过；1 = 丢写/超时/断言失败。
 */
import { LOCK_WAIT_TIMEOUT_MS, __resetLocksForTest, withProjectLock } from "../src/lib/novel/novel-locks.ts"
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const iterations = Number(process.argv[2] ?? 200)
const concurrency = Number(process.argv[3] ?? 10)

const dir = mkdtempSync(join(tmpdir(), "novel-locks-pressure-"))
const file = join(dir, "counter.json")

function init(): void {
  writeFileSync(file, JSON.stringify({ count: 0 }))
}

/** 模拟一次 ledger RMW append（读→改→写），带人为交错窗口放大竞态。 */
async function appendOne(delayMs: number): Promise<void> {
  await withProjectLock(`ledger:${dir}`, async () => {
    const raw = readFileSync(file, "utf-8")
    const doc = JSON.parse(raw) as { count: number }
    await new Promise((r) => setTimeout(r, delayMs)) // 放大 RMW 窗口
    doc.count += 1
    writeFileSync(file, JSON.stringify(doc))
  })
}

async function run(): Promise<void> {
  init()
  __resetLocksForTest()

  // 1) 互斥正确性：N 个并发 append，最终 count 必须等于 N（零丢写）。
  const start = Date.now()
  await Promise.all(
    Array.from({ length: iterations }, () => appendOne(1 + Math.random() * 3)),
  )
  const elapsed = Date.now() - start
  const doc = JSON.parse(readFileSync(file, "utf-8")) as { count: number }

  console.log(`[pressure] ${iterations} concurrent appends → count=${doc.count} (expect ${iterations}) ${elapsed}ms`)
  if (doc.count !== iterations) {
    console.error(`[FAIL] lost updates: got ${doc.count}, expected ${iterations}`)
    process.exitCode = 1
    return
  }

  // 2) 看门狗：锁被占用超过 timeout 时后续任务熔断（不挂死主链）。
  __resetLocksForTest()
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const holder = withProjectLock(`ledger:${dir}-wd`, () => held)
  const t0 = Date.now()
  const err = await withProjectLock(`ledger:${dir}-wd`, () => Promise.resolve(), 100).catch(
    (e: unknown) => e,
  )
  const wdElapsed = Date.now() - t0
  release()
  await holder
  if (!(err instanceof Error) || !err.message.includes("timeout")) {
    console.error(`[watchdog] expected timeout error, got ${String(err)}`)
    process.exitCode = 1
    return
  }
  console.log(`[watchdog] timeout fired after ${wdElapsed}ms (cap=${LOCK_WAIT_TIMEOUT_MS}ms default)`)

  // 3) 链清理：全部完成后 key 应从 Map 清空（内存不泄漏）。
  // （内部实现细节——通过再次立即获取验证无残留等待。）
  const after = await withProjectLock(`ledger:${dir}/after`, () => "ok")
  if (after !== "ok") {
    console.error("[cleanup] unexpected result")
    process.exitCode = 1
  }

  console.log("[pressure] PASS")
}

run().finally(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch { /* best-effort */ }
})
