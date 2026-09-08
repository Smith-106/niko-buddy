// Unified version bump across four places:
//   package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml / src-tauri/Cargo.lock
// Usage: node scripts/bump-version.mjs <x.y.z>
//
// Gates (fail-closed, exit 1, no writes on failure):
//   G1. target must be registered in src/lib/changelog.ts ENTRIES. The script
//       imports the .ts file directly (native TS type stripping, needs Node
//       >= 22.18; on import failure it exits 1 with that hint).
//   G2. src-tauri/Cargo.lock must contain exactly one anchor: a line
//       `name = "niko-buddy"` immediately followed by a `version = "x.y.z"`
//       line. 0 matches (package entry missing) or >1 matches (ambiguous
//       duplicate) both abort before any write.
//
// Also prints a change manifest (which files will be written) before writing,
// and hints when old version strings (any ENTRIES version other than the
// target) still appear under src/ (non-fatal).
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const target = process.argv[2]

const fail = (msg) => {
  console.error("bump-version: " + msg)
  process.exit(1)
}

if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
  fail('usage: node scripts/bump-version.mjs <x.y.z> (got "' + (target ?? "") + '")')
}

// ---- Gate 1: target version must exist in src/lib/changelog.ts ENTRIES ----
let knownVersions = []
try {
  const mod = await import(pathToFileURL(resolve(root, "src/lib/changelog.ts")).href)
  if (!Array.isArray(mod.ENTRIES)) fail("src/lib/changelog.ts does not export an ENTRIES array")
  knownVersions = mod.ENTRIES.map((e) => e.version).filter(Boolean)
} catch (err) {
  fail(
    "cannot import src/lib/changelog.ts ENTRIES: " + err.message +
    " (needs Node >= 22.18 for native TS type stripping; current is " + process.version + ")"
  )
}
if (!knownVersions.includes(target)) {
  fail(
    "target version " + target + " is not registered in src/lib/changelog.ts ENTRIES " +
    "(" + knownVersions.length + " entries, newest: " + knownVersions.slice(0, 5).join(", ") + "); " +
    "add a changelog entry first"
  )
}

// ---- Read the four version-bearing files ----
const pkgPath = resolve(root, "package.json")
const confPath = resolve(root, "src-tauri/tauri.conf.json")
const cargoPath = resolve(root, "src-tauri/Cargo.toml")
const lockPath = resolve(root, "src-tauri/Cargo.lock")

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const conf = JSON.parse(readFileSync(confPath, "utf8"))
const cargo = readFileSync(cargoPath, "utf8")
const lock = readFileSync(lockPath, "utf8")

// ---- Gate 2: Cargo.lock anchor must match exactly once ----
// Anchor = a `name = "niko-buddy"` line immediately followed by a `version = "x.y.z"` line.
const lockAnchor = /^name = "niko-buddy"\r?\nversion = "([^"]+)"/gm
const lockMatches = [...lock.matchAll(lockAnchor)]
if (lockMatches.length !== 1) {
  fail(
    'Cargo.lock anchor name = "niko-buddy" + adjacent version line matched ' +
    lockMatches.length + " time(s), expected exactly 1 " +
    "(0 = package entry missing from lock, >1 = ambiguous duplicate); refusing to write"
  )
}

// ---- Current versions + change manifest (files to be written) ----
const FILES = [
  { name: "package.json",             cur: pkg.version },
  { name: "src-tauri/tauri.conf.json", cur: conf.version },
  { name: "src-tauri/Cargo.toml",     cur: cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] },
  { name: "src-tauri/Cargo.lock",     cur: lockMatches[0][1] },
]

const plan = FILES.filter((f) => f.cur !== target)

console.log("bump-version: target " + target)
if (plan.length === 0) {
  console.log("all four files already at " + target + " (no changes)")
} else {
  console.log("change manifest (files to be written):")
  for (const f of plan) console.log("  " + f.name.padEnd(28) + f.cur + " -> " + target)
}
console.log(
  'info: Cargo.lock anchor name = "niko-buddy" + adjacent version line: ' +
  lockMatches.length + " match(es) (gate: != 1 refuses to write)"
)

// ---- Apply ----
if (pkg.version !== target) {
  pkg.version = target
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
}
if (conf.version !== target) {
  conf.version = target
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n", "utf8")
}
if (FILES[2].cur !== target) {
  writeFileSync(cargoPath, cargo.replace(/^version\s*=\s*"[^"]+"/m, 'version = "' + target + '"'), "utf8")
}
if (FILES[3].cur !== target) {
  const hit = lockMatches[0][0]
  writeFileSync(lockPath, lock.replace(hit, hit.replace(/version = "[^"]+"/, 'version = "' + target + '"')), "utf8")
}

// ---- Hint: old version strings still present under src/ (non-fatal) ----
const stale = knownVersions.filter((v) => v !== target).sort((a, b) => b.length - a.length)
if (stale.length > 0) {
  try {
    const staleRe = new RegExp(
      "(?<![0-9])(?:" + stale.map((v) => v.replace(/\./g, "\\.")).join("|") + ")(?![0-9])",
      "g"
    )
    const hints = []
    for (const rel of readdirSync(resolve(root, "src"), { recursive: true })) {
      const relPosix = rel.split("\\").join("/")
      if (relPosix === "lib/changelog.ts") continue // registry data, not a straggler
      const st = statSync(join(root, "src", rel), { throwIfNoEntry: false })
      if (!st || !st.isFile() || st.size > 1_000_000) continue
      let text
      try { text = readFileSync(join(root, "src", rel), "utf8") } catch { continue }
      if (text.includes("\0")) continue // binary-ish
      const found = new Map()
      for (const m of text.matchAll(staleRe)) found.set(m[0], (found.get(m[0]) ?? 0) + 1)
      if (found.size > 0) hints.push({ rel: relPosix, found })
    }
    if (hints.length > 0) {
      console.log("info: old version strings still present under src/ (review if intentional):")
      for (const h of hints) {
        const what = [...h.found.entries()].map(([v, n]) => v + " x" + n).join(", ")
        console.log("  src/" + h.rel + ": " + what)
      }
    } else {
      console.log("info: no old version strings found under src/")
    }
  } catch (err) {
    console.log("info: old version scan skipped: " + err.message)
  }
}

// ---- Summary ----
if (plan.length === 0) {
  console.log("bump complete: no files changed")
} else {
  console.log("bump complete: " + plan.map((f) => f.name + " " + f.cur + " -> " + target).join(", "))
}
console.log("next: git add the changed files, then tag per RELEASING.md (npm run build:github-release)")
