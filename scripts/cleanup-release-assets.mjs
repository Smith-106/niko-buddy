#!/usr/bin/env node
/**
 * 清理历史 release 资产双命名残留（生态建设 P0，2026-08-29）。
 * 动作：删除全部 release 中的 QMaiWrite_* 资产；统一标题为 "Niko Buddy v<ver>"。
 * 用法：node scripts/cleanup-release-assets.mjs [--dry-run]
 */
import { execSync } from "node:child_process"

const REPO = "Smith-106/niko-buddy"
const DRY = process.argv.includes("--dry-run")

function gh(args) {
  return execSync(`gh ${args} -R ${REPO}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

const releases = JSON.parse(gh("release list --limit 100 --json tagName,name,isDraft,isPrerelease"))
console.log(`releases: ${releases.length}`)

let deleted = 0
let renamed = 0
for (const r of releases) {
  const assets = JSON.parse(gh(`release view ${r.tagName} --json assets -q .assets`))
  for (const a of assets) {
    if (a.name.startsWith("QMaiWrite_")) {
      if (DRY) {
        console.log(`[dry] delete ${r.tagName}: ${a.name}`)
      } else {
        gh(`release delete-asset ${r.tagName} ${a.name} -y`)
        console.log(`deleted ${r.tagName}: ${a.name}`)
      }
      deleted++
    }
  }
  const expected = `Niko Buddy v${r.tagName.replace(/^v/, "")}`
  if (r.name !== expected) {
    if (DRY) {
      console.log(`[dry] rename ${r.tagName}: "${r.name}" -> "${expected}"`)
    } else {
      gh(`release edit ${r.tagName} --title "${expected}"`)
      console.log(`renamed ${r.tagName} -> ${expected}`)
    }
    renamed++
  }
}
console.log(`done: deleted=${deleted} renamed=${renamed}${DRY ? " (dry-run)" : ""}`)
