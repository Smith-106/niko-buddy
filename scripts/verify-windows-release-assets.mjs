/**
 * Windows 发布产物本地校验（release-source wave）：
 *   - 4 个文件名/大小/sha256 + installer blake2b512 摘要
 *   - release-notes.txt 非空（仅作草稿 notes，不作为资产上传）
 *   - latest.json 的 UTC 发布时间合法，版本、说明、签名和 URL 与发布文件一致
 *   - Ed25519 签名真实验证（minisign packet 结构 + Node crypto verify）
 *   - 可选第二参：gh api 资产元数据页数组，校验上传资产名/状态/大小/摘要
 * 任何一项失败即抛错退出；不签名、不联网、不读私钥。
 * 验证仅证明暂存字节与签名/清单一致，不宣称安装器运行时行为。
 */
import assert from "node:assert/strict"
import { createHash, createPublicKey, verify } from "node:crypto"
import { closeSync, createReadStream, openSync, readFileSync, readSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export function windowsAssetNames(version) {
  const stem = `niko-buddy_${version}_windows_X64`
  return [`${stem}.exe`, `${stem}.exe.sig`, `${stem}_portable.zip`, "latest.json"]
}

export function isZipMagicHeader(bytes) {
  return Boolean(
    bytes &&
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04,
  )
}

export function checkUpdaterManifest(manifest, signature, repo, tag, version) {
  const [installer] = windowsAssetNames(version)
  assert.equal(tag, `v${version}`, "Tag must match the built application version")
  assert.equal(manifest?.version, version, "Updater version differs from the build")
  assert.ok(typeof manifest.notes === "string" && manifest.notes.trim(), "Updater notes must be a nonempty string")
  const pubDate = manifest.pub_date
  // 部分无效日期会被 Date 进位；回读秒级时间可拒绝这类日期。
  assert.ok(
    typeof pubDate === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(pubDate) &&
      Number.isFinite(Date.parse(pubDate)) &&
      new Date(pubDate).toISOString().slice(0, 19) === pubDate.slice(0, 19),
    "Updater pub_date must be a valid ISO-8601 UTC timestamp",
  )
  const platform = manifest.platforms?.["windows-x86_64"]
  assert.ok(
    platform && typeof platform === "object" && !Array.isArray(platform) && Object.keys(manifest.platforms).length === 1,
    "Expected only the windows-x86_64 updater platform",
  )
  assert.ok(signature, "Empty updater sidecar signature")
  assert.equal(platform.signature, signature, "Updater signature differs from the sidecar")
  assert.equal(platform.url, `https://github.com/${repo}/releases/download/${tag}/${installer}`, "Unexpected updater URL")
}

export function checkUploadedAssets(files, pages) {
  assert.ok(Array.isArray(pages) && pages.every(Array.isArray), "Expected paginated asset metadata")
  const assets = pages.flat()
  assert.equal(assets.length, files.length, "Unexpected number of draft assets")
  for (const file of files) {
    const matches = assets.filter((asset) => asset.name === file.name)
    assert.equal(matches.length, 1, `Missing or duplicate draft asset: ${file.name}`)
    const [asset] = matches
    assert.equal(asset.state, "uploaded", `Incomplete upload: ${file.name}`)
    assert.equal(asset.size, file.size, `Wrong uploaded size: ${file.name}`)
    assert.equal(asset.digest, `sha256:${file.sha256}`, `Wrong uploaded digest: ${file.name}`)
  }
}

export function verifyMinisignSignature(installerDigest, sidecarBase64, pubkeyBase64) {
  // minisign/Ed25519 真实验签（结构 + 密码学两层）。
  const keyLines = Buffer.from(pubkeyBase64 ?? "", "base64").toString("utf8").trim().split(/\r?\n/)
  const keyPacket = Buffer.from(keyLines[1] ?? "", "base64")
  assert.equal(keyPacket.length, 42, "Unexpected updater public key packet")
  assert.equal(keyPacket.subarray(0, 2).toString("ascii"), "Ed")
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyPacket.subarray(10)]),
    format: "der",
    type: "spki",
  })
  const signatureLines = Buffer.from(sidecarBase64 ?? "", "base64").toString("utf8").trim().split(/\r?\n/)
  assert.equal(signatureLines.length, 4, "Unexpected sidecar signature layout")
  const trustedComment = "trusted comment: "
  assert.ok(signatureLines[2].startsWith(trustedComment), "Missing trusted comment")
  const packet = Buffer.from(signatureLines[1], "base64")
  assert.equal(packet.length, 74, "Unexpected signature packet")
  assert.equal(packet.subarray(0, 2).toString("ascii"), "ED")
  assert.ok(packet.subarray(2, 10).equals(keyPacket.subarray(2, 10)), "Signature key ID differs from updater key")
  const globalSignature = Buffer.from(signatureLines[3], "base64")
  assert.equal(globalSignature.length, 64, "Unexpected global signature")
  const signature = packet.subarray(10)
  assert.equal(verify(null, installerDigest, publicKey, signature), true, "Installer signature verification failed")
  assert.equal(
    verify(null, Buffer.concat([signature, Buffer.from(signatureLines[2].slice(trustedComment.length))]), publicKey, globalSignature),
    true,
    "Global signature verification failed",
  )
}

async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest()
}

async function main() {
  const [dir, assetsMetaPath] = process.argv.slice(2)
  assert.ok(dir && dir.length > 0, "usage: node scripts/verify-windows-release-assets.mjs <release-assets-dir> [uploaded-assets.json]")
  const repo = process.env.GITHUB_REPOSITORY
  const tag = process.env.GITHUB_REF_NAME
  assert.ok(repo, "GITHUB_REPOSITORY is required")
  assert.ok(tag, "GITHUB_REF_NAME is required")
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const updater = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  const version = pkg.version
  assert.equal(updater.version, version, "Tauri version differs from package.json")

  const names = windowsAssetNames(version)
  const files = []
  let installerDigest
  for (const name of names) {
    const hash = createHash("sha256")
    let size = 0
    for await (const chunk of createReadStream(join(dir, name))) {
      hash.update(chunk)
      size += chunk.length
    }
    assert.ok(size > 0, `Empty or missing release file: ${name}`)
    if (name.endsWith("_portable.zip")) {
      const header = Buffer.alloc(4)
      const fd = openSync(join(dir, name), "r")
      try {
        readSync(fd, header, 0, 4, 0)
      } finally {
        closeSync(fd)
      }
      assert.ok(isZipMagicHeader(header), `Portable zip has invalid ZIP header: ${name}`)
    }
    files.push({ name, size, sha256: hash.digest("hex") })
  }
  installerDigest = await hashFile(join(dir, names[0]), "blake2b512")

  const notes = readFileSync(join(dir, "release-notes.txt"), "utf8").trim()
  assert.ok(notes.length > 0, "Empty release-notes.txt")
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"))
  const sidecar = readFileSync(join(dir, names[1]), "utf8").trim()
  checkUpdaterManifest(manifest, sidecar, repo, tag, version)
  assert.ok(manifest.notes.trim() === notes, "Updater notes differ from release-notes.txt")

  verifyMinisignSignature(installerDigest, sidecar, updater.plugins?.updater?.pubkey ?? updater.updater?.pubkey ?? "")

  let uploadedVerified = false
  if (assetsMetaPath !== undefined) {
    checkUploadedAssets(files, JSON.parse(readFileSync(assetsMetaPath, "utf8")))
    uploadedVerified = true
  }

  console.log(JSON.stringify({ tag, files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })), uploadedVerified }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
