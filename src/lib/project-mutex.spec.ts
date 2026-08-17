import { beforeEach, describe, expect, it } from "vitest"
import { __resetProjectLocksForTesting, withProjectLock } from "./project-mutex"

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  __resetProjectLocksForTesting()
})

describe("withProjectLock", () => {
  it("serializes concurrent calls for the same project", async () => {
    const order: string[] = []
    const gate = deferred<void>()
    const p1 = withProjectLock("/proj", async () => {
      await gate.promise
      order.push("first")
    })
    // The second call must not enter until the first releases the lock.
    const p2 = withProjectLock("/proj", async () => {
      order.push("second")
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    gate.resolve()
    await p1
    await p2
    expect(order).toEqual(["first", "second"])
  })

  it("lets different projects run concurrently", async () => {
    const order: string[] = []
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const p1 = withProjectLock("/proj-a", async () => {
      await gateA.promise
      order.push("a")
    })
    const p2 = withProjectLock("/proj-b", async () => {
      await gateB.promise
      order.push("b")
    })
    gateB.resolve()
    await p2
    expect(order).toEqual(["b"])
    gateA.resolve()
    await p1
    expect(order).toEqual(["b", "a"])
  })

  it("releases the lock when the held fn rejects", async () => {
    const fail = withProjectLock("/proj", async () => {
      throw new Error("boom")
    })
    await expect(fail).rejects.toThrow("boom")

    // A subsequent call still runs — the previous rejection didn't wedge the chain.
    const ran: string[] = []
    await withProjectLock("/proj", async () => {
      ran.push("ok")
    })
    expect(ran).toEqual(["ok"])
  })

  it("propagates the fn result", async () => {
    const result = await withProjectLock("/proj", async () => 42)
    expect(result).toBe(42)
  })

  it("returns the resolved value of the fn even when a previous holder rejected", async () => {
    const gate = deferred<void>()
    const p1 = withProjectLock("/proj", async () => {
      await gate.promise
      throw new Error("earlier failure")
    })
    // Start a second call while the first is still pending; it chains behind.
    const p2 = withProjectLock("/proj", async () => "value")
    gate.resolve()
    await expect(p1).rejects.toThrow("earlier failure")
    await expect(p2).resolves.toBe("value")
  })

  it("keeps the lock map bounded under a large burst of distinct paths", async () => {
    // 1025 concurrent holders across distinct project paths trips the
    // `locks.size > 1024` cleanup guard inside the finally block.
    const gates = Array.from({ length: 1025 }, () => deferred<void>())
    const ran: string[] = []
    const promises = gates.map((g, i) =>
      withProjectLock(`/proj-${i}`, async () => {
        await g.promise
        ran.push(String(i))
      }),
    )
    await Promise.resolve()
    // Release in a staggered fashion so cleanup runs while others are pending.
    for (let i = 0; i < gates.length; i += 100) {
      const slice = gates.slice(i, i + 100)
      slice.forEach((g) => g.resolve())
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(promises)
    expect(ran).toHaveLength(1025)
  })

  it("clears all live locks via the test helper", async () => {
    await withProjectLock("/proj", async () => "done")
    expect(() => __resetProjectLocksForTesting()).not.toThrow()
    const gate = deferred<void>()
    const p1 = withProjectLock("/proj", async () => {
      await gate.promise
      return "after-reset"
    })
    __resetProjectLocksForTesting()
    // A call made after the reset must not wait on the pre-reset holder.
    const p2 = withProjectLock("/proj", async () => "fresh")
    gate.resolve()
    await expect(p2).resolves.toBe("fresh")
    await p1
  })

  it("tolerates the deferred cleanup when the tail entry is already gone", async () => {
    // Flood the map past 1024 so every finally block enters the cleanup
    // guard. Three same-path calls chain onto one tail entry; A's deferred
    // check deletes it, so B's and C's finally blocks observe an absent tail
    // (`if (tail)` false path) and skip scheduling their own checks.
    const gates = Array.from({ length: 1025 }, () => deferred<void>())
    const flood = gates.map((g, i) =>
      withProjectLock(`/flood-${i}`, async () => {
        await g.promise
      }),
    )
    await Promise.resolve()

    const pA = withProjectLock("/target", async () => "a")
    const pB = withProjectLock("/target", async () => "b")
    const pC = withProjectLock("/target", async () => "c")
    await Promise.all([pA, pB, pC])

    gates.forEach((g) => g.resolve())
    await Promise.all(flood)

    // The map is still usable afterwards and the lock is released.
    await expect(withProjectLock("/target", async () => "again")).resolves.toBe("again")
  })
})
