/**
 * corpus-isolation.spec.mjs — N5 隔离不变量测试（20260824 三模型共识落地）
 *
 * 四组断言：
 *   A 组：入库产物静态隔离（fresh clone 可跑，零外部依赖）
 *   B 组：打包器动态行为（fixture 树 + 金丝雀，验证 quarantined 文本不可达产物）
 *   C 组：授权轨拒绝 unlicensed（校验先行于写盘，不落盘）
 *   D 组：corpus-guard 辅助函数单元测试
 *
 * 运行方式：execFileSync(process.execPath)（照抄 release-notes.spec.mjs 先例，
 * 规避 Windows node shim 与中文路径 shell 引号问题）。
 */
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CONSUMABLE_STATUS, GENRE_ENUM, assertBatchesIndexed } from "./lib/corpus-guard.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKER = resolve(__dirname, "generate-anti-ai-corpus-bundle.mjs")
const INGEST_AUTH = resolve(__dirname, "ingest-authorized-corpus.mjs")
const COMMITTED_BUNDLE = resolve(__dirname, "../src/lib/novel/anti-ai-seeds.generated.json")
const CANARY = "LEAK-CANARY-7f3a"

// ───────────────────────── A 组：入库产物静态隔离 ─────────────────────────

describe.skipIf(!existsSync(COMMITTED_BUNDLE))("A 组·入库产物静态隔离", () => {
  const bundle = JSON.parse(readFileSync(COMMITTED_BUNDLE, "utf8"))

  it("A1/A2: samples[].file 形如 {layer}/batch-{id}/{genre}-{NNN}.txt 且批次 ∈ 白名单", () => {
    const fileRe = /^(human|ai)\/(batch-\d{8}-[a-z0-9-]+)\/([a-z]+)-\d{3}\.txt$/
    for (const s of bundle.samples) {
      const m = fileRe.exec(s.file)
      expect(m, `文件名不合规范: ${s.file}`).toBeTruthy()
      expect(m[2]).toBe("batch-20260821-001")
    }
    for (const id of bundle.batchIds) expect(id).toBe("20260821-001")
  })

  it('A3: 整个 JSON 序列化串不含 "unlicensed" 子串', () => {
    expect(JSON.stringify(bundle)).not.toContain("unlicensed")
  })

  it("A4: 每个 genre ∈ GENRE_ENUM（锁死 N3，含 unknown 回归）", () => {
    for (const s of bundle.samples) {
      expect(GENRE_ENUM, `genre 越界: ${s.genre}`).toContain(s.genre)
    }
  })
})

// ───────────────────────── B 组：打包器动态行为 ─────────────────────────

/** 搭 fixture 语料树：indexed 批 + 金丝雀 quarantined 批 */
function makeFixtureTree(root, { poisonFileName, badGenreFile, allowedStatus = "indexed" } = {}) {
  const humanAllowed = join(root, "human", "batch-20260821-001")
  const humanQuarantined = join(root, "human", "batch-99999999-unlicensed-ref")
  mkdirSync(humanAllowed, { recursive: true })
  mkdirSync(humanQuarantined, { recursive: true })
  writeFileSync(join(humanAllowed, "gufeng-001.txt"), "夜色沉沉她推开雕花木窗看庭前雨打芭蕉檐角铜铃轻响。".repeat(4))
  if (poisonFileName) writeFileSync(join(humanAllowed, poisonFileName), "毒文件名内容。".repeat(10))
  if (badGenreFile) writeFileSync(join(humanAllowed, badGenreFile), "越界 genre 内容。".repeat(10))
  // 金丝雀只存在于 quarantined 批——任何出现在产物中即泄漏
  writeFileSync(join(humanQuarantined, "yanqing-001.txt"), (CANARY + "。").repeat(20))
  const manifest = {
    batches: [
      { id: "batch-20260821-001", status: allowedStatus },
      { id: "batch-99999999-unlicensed-ref", status: "quarantined" },
    ],
    samples: [],
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8")
}

function runPacker(root, output) {
  return execFileSync(process.execPath, [PACKER], {
    stdio: "pipe",
    env: { ...process.env, ANTI_AI_CORPUS_ROOT: root, ANTI_AI_BUNDLE_OUTPUT: output },
  })
}

describe("B 组·打包器动态行为", () => {
  it("B5 happy path: 仅含 indexed 批样本，金丝雀不可达产物", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-guard-b5-"))
    makeFixtureTree(root)
    const out = join(root, "bundle.json")
    runPacker(root, out)
    const bundle = JSON.parse(readFileSync(out, "utf8"))
    expect(JSON.stringify(bundle)).not.toContain(CANARY)
    expect(bundle.samples.map((s) => s.file)).toHaveLength(1)
    expect(bundle.samples[0].file).toBe("human/batch-20260821-001/gufeng-001.txt")
  })

  it("B6 毒文件名（unlicensed-ref）→ RED LINE throw", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-guard-b6-"))
    makeFixtureTree(root, { poisonFileName: "gufeng-unlicensed-ref-099.txt" })
    const out = join(root, "bundle.json")
    expect(() => runPacker(root, out)).toThrow(/RED LINE/)
  })

  it.each([
    ["fakegenre-001.txt", /non-enum genre/],
    ["broken.txt", /non-enum genre/],
  ])("B7 genre 越界 %s → non-enum genre throw（N3）", (name, pattern) => {
    const root = mkdtempSync(join(tmpdir(), "corpus-guard-b7-"))
    makeFixtureTree(root, { badGenreFile: name })
    const out = join(root, "bundle.json")
    try {
      runPacker(root, out)
      expect.unreachable("应当 throw")
    } catch (err) {
      expect(String(err.message)).toMatch(pattern)
    }
  })

  it("B8 pin 批次非 indexed（manifest 改 quarantined）→ 不可消费 throw（N3 加固）", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-guard-b8-"))
    makeFixtureTree(root, { allowedStatus: "quarantined" })
    const out = join(root, "bundle.json")
    try {
      runPacker(root, out)
      expect.unreachable("应当 throw")
    } catch (err) {
      expect(String(err.message)).toMatch(/不可消费|corpus-guard/)
    }
  })
})

// ───────────────────────── C 组：授权轨拒绝 unlicensed ─────────────────────────

function runIngestAuth(args) {
  return execFileSync(process.execPath, [INGEST_AUTH, ...args], { stdio: "pipe" })
}

describe("C 组·授权轨红线（校验先行于写盘）", () => {
  it("C9 批次名含 unlicensed → 红线拒绝", () => {
    expect(() =>
      runIngestAuth([
        "--batch-id", "batch-unlicensed-probe",
        "--source-dir", "Z:/definitely-not-exist",
        "--layer", "human",
        "--license-status", "explicit-permission",
      ]),
    ).toThrow(/红线|batch-id 需形如/)
  })

  it.each(["unlicensed-disputed", "self-authored"])("C10 license-status=%s → 枚举拒绝", (status) => {
    expect(() =>
      runIngestAuth([
        "--batch-id", "batch-20260824-probe",
        "--source-dir", "Z:/definitely-not-exist",
        "--layer", "human",
        "--license-status", status,
      ]),
    ).toThrow(/六值之一/)
  })

  it("C11 happy path: 授权轨产出必为 indexed 状态", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-guard-c11-"))
    const corpusRoot = join(root, "corpus")
    const srcDir = join(root, "src")
    mkdirSync(corpusRoot, { recursive: true })
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(corpusRoot, "manifest.json"), JSON.stringify({ batches: [], samples: [] }, null, 2), "utf-8")
    const paras = Array.from({ length: 12 }, (_, k) => (`第${k}段。` + "夜色沉沉她推开雕花木窗看庭前雨打芭蕉檐角铜铃轻响").padEnd(60, "。"))
    writeFileSync(join(srcDir, "book1.txt"), paras.join("\n\n"), "utf-8")
    runIngestAuth([
      "--batch-id", "batch-20260824-c11",
      "--source-dir", srcDir,
      "--layer", "human",
      "--license-status", "explicit-permission",
      "--genre", "yanqing",
      "--corpus-root", corpusRoot,
    ])
    const manifest = JSON.parse(readFileSync(join(corpusRoot, "manifest.json"), "utf8"))
    expect(manifest.batches[0].status).toBe(CONSUMABLE_STATUS)
    expect(manifest.batches[0].license_status ?? manifest.batches[0].license_channel).toBe("explicit-permission")
  })
})

// ───────────────────────── D 组：corpus-guard 单元测试 ─────────────────────────

describe("D 组·assertBatchesIndexed 单元测试", () => {
  function fixtureManifest(batches) {
    const root = mkdtempSync(join(tmpdir(), "corpus-guard-d-"))
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ batches }, null, 2), "utf-8")
    return root
  }

  it("D12a manifest 缺失 → throw", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-guard-d12-"))
    expect(() => assertBatchesIndexed(root, ["20260821-001"])).toThrow(/manifest 不存在/)
  })

  it("D12b 非 indexed 状态全部拒绝且消息含批次 id", () => {
    for (const status of ["quarantined", "pending", "blocked"]) {
      const root = fixtureManifest([{ id: "batch-x-1", status }])
      try {
        assertBatchesIndexed(root, ["x-1"])
        expect.unreachable(`${status} 应当 throw`)
      } catch (err) {
        expect(String(err.message)).toContain("batch-x-1")
      }
    }
  })

  it("D12c 裸 id 前缀归一化生效；全 indexed 静默通过", () => {
    const root = fixtureManifest([{ id: "batch-y-2", status: "indexed" }])
    expect(() => assertBatchesIndexed(root, ["y-2", "batch-y-2"])).not.toThrow()
  })

  it("D12e 空 batchIds → no-op；损坏 JSON → throw", () => {
    const good = fixtureManifest([])
    expect(() => assertBatchesIndexed(good, [])).not.toThrow()
    const bad = mkdtempSync(join(tmpdir(), "corpus-guard-d12e-"))
    writeFileSync(join(bad, "manifest.json"), "{broken json", "utf-8")
    expect(() => assertBatchesIndexed(bad, ["z-1"])).toThrow(/解析失败/)
  })
})
