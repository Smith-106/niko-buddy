// 统一同步三处版本号：package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
// 用法：node scripts/bump-version.mjs <new-version>   （如 2.4.9；版本源以 package.json 为准）
import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const target = process.argv[2]
if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
  console.error("用法：node scripts/bump-version.mjs <x.y.z>")
  process.exit(1)
}

const pkgPath = resolve(root, "package.json")
const confPath = resolve(root, "src-tauri/tauri.conf.json")
const cargoPath = resolve(root, "src-tauri/Cargo.toml")

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const conf = JSON.parse(readFileSync(confPath, "utf8"))
const cargo = readFileSync(cargoPath, "utf8")

const before = [pkg.version, conf.version, cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]]
const changed = []

if (pkg.version !== target) {
  pkg.version = target
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  changed.push("package.json")
}
if (conf.version !== target) {
  conf.version = target
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n", "utf8")
  changed.push("src-tauri/tauri.conf.json")
}
if (before[2] !== target) {
  writeFileSync(cargoPath, cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${target}"`), "utf8")
  changed.push("src-tauri/Cargo.toml")
}

if (changed.length === 0) {
  console.log(`三处版本已一致：${target}（无需改动）`)
} else {
  console.log(`版本已统一：${before.join(" / ")} → ${target}`)
  console.log(`改动：${changed.join(", ")}`)
  console.log("下一步：git add 后按发布流程打 tag（npm run build:github-release）")
}
