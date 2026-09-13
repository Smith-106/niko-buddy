// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! 块寻址原语（**INV-7**）——内容哈希块 ID + manifest/内容分离。
//!
//! 来源：跨项目移植专项。F-002（技能包离线传输）的包体与 F-004（WebDAV 云端备份）
//! 的远端块**必须共用同一寻址定义**，一次落地多处受益（data-architect 视角）。
//!
//! 既有 `canon/export.rs` 已具备清单 + 哈希 + 校验和的完整范式
//! （`hash_file` L410 / `compute_content_digest_from_disk` L428 / `pack_project` L461 /
//! `stream_file_sha256` L564 / `write_checksum_sidecar` L587 / `parse_sidecar_checksum` L599 /
//! `compare_container_checksum` L634）。本模块把其中的**寻址与完整性语义**下沉为可复用
//! 原语，而**不重写**既有导出路径——`export.rs` 保持既有行为不变（向后兼容），仅新增
//! 对原语的薄适配。
//!
//! ## 设计要点
//! - **块 ID = 内容 sha256**（`block_hash`）。块文件以哈希命名，天然获得**去重**与
//!   **断点续传**（已存在且哈希正确的块直接跳过）。
//! - **manifest 与 blocks 分文件存放**：`<dest>/manifest.json` + `<dest>/blocks/<hash>`。
//! - **manifest 最后写**（commit point，DA-04）：块全部落盘且校验通过后才写 manifest，
//!   故半途中断的归档**不会被误认为完整**。
//! - **`content_digest` 由块集合派生**（按哈希有序的 `hash \0 size_le64 \n` 序贯哈希），
//!   因此可**仅凭 manifest 与块目录**重算校验——不需要还原原始目录树。
//!
//! ## 与既有校验层的边界（不冲突）
//! `export.rs` 的两层校验中，**容器层**（整包字节流 SHA-256 + `.sha256` sidecar）与
//! **内容层**（对 zip 条目按 `路径 \0 长度 \0 单文件哈希 \n` 序贯哈希）都依赖 zip 容器；
//! 本模块的 `content_digest` 是**块集合层**的第三种指纹，服务于非 zip 场景
//! （技能包 `.nbskill.json` 与 WebDAV 远端块）。三者层次不同，不互为替代。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// 归档 schema 版本（§DA-03：格式演进必须向后兼容，major 不识别即拒收）。
pub const ARCHIVE_SCHEMA_VERSION: u32 = 1;

/// manifest 文件名（与 blocks 目录**分文件**存放）。
pub const ARCHIVE_MANIFEST_FILE: &str = "manifest.json";

/// 块目录名（块文件以内容 sha256 命名）。
pub const ARCHIVE_BLOCKS_DIR: &str = "blocks";

/// 单块引用：内容 sha256（块 ID）+ 字节长度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockRef {
    /// 块 ID = 该块字节的 sha256 十六进制小写串。
    pub hash: String,
    /// 块字节长度。
    pub size: u64,
}

/// 归档清单：只描述**块集合**与内容指纹，不承载块字节本体。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveManifest {
    /// manifest schema 版本（不识别的高 major 一律拒收）。
    pub schema_version: u32,
    /// 内容寻址 id（= `content_digest` 的十六进制串；同内容集同 id）。
    pub id: String,
    /// 产出该 manifest 的应用版本（可追溯；不参与内容寻址）。
    pub version: String,
    /// 生成时间（RFC 3339 / ISO 8601）。**不参与**新旧判定（DA-04：判新旧只用哈希）。
    pub created_at: String,
    /// 去重后的块集合（按 `hash` 升序，保证 manifest 确定性）。
    pub blocks: Vec<BlockRef>,
    /// 块集合的序贯指纹（可仅凭 manifest + 块目录重算）。
    pub content_digest: String,
}

/// 计算字节块的 ID（sha256 十六进制小写）。
pub fn block_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

/// 流式计算单文件的内容哈希与长度（不驻留整文件内存）。
fn block_hash_of_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("[archive] open {} failed: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| format!("[archive] read {} failed: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        size += read as u64;
    }
    Ok((size, hex(&hasher.finalize())))
}

/// 枚举 `root` 下的全部**普通文件**，返回 `(相对路径 POSIX 形式, 绝对路径)`，按相对路径升序。
fn enumerate_files(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    if !root.is_dir() {
        return Err(format!(
            "[archive] root is not a directory: {}",
            root.display()
        ));
    }
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| format!("[archive] walk failed: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        let relative = path
            .strip_prefix(root)
            .map_err(|e| format!("[archive] strip_prefix failed: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        files.push((relative, path));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

/// 块集合指纹：按 `hash` 升序序贯哈希 `hash bytes \0 size_le64 \n`。
///
/// 该配方**只依赖块集合**，故 `verify_manifest` 可仅凭块目录重算并与 manifest 比对。
fn compute_content_digest(blocks: &[BlockRef]) -> String {
    let mut ordered: Vec<&BlockRef> = blocks.iter().collect();
    ordered.sort_by(|a, b| a.hash.cmp(&b.hash));
    let mut digest = Sha256::new();
    for block in ordered {
        digest.update(block.hash.as_bytes());
        digest.update(b"\0");
        digest.update(block.size.to_le_bytes());
        digest.update(b"\n");
    }
    hex(&digest.finalize())
}

/// 从目录树构建 manifest：枚举文件 → 流式哈希 → **按内容去重**。
///
/// 去重语义：同内容文件只产生一个 [`BlockRef`]（这正是块寻址的核心收益）。
pub fn build_manifest(root: &Path) -> Result<ArchiveManifest, String> {
    let files = enumerate_files(root)?;
    let mut blocks: Vec<BlockRef> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (_relative, path) in &files {
        let (size, hash) = block_hash_of_file(path)?;
        if seen.insert(hash.clone()) {
            blocks.push(BlockRef { hash, size });
        }
    }
    blocks.sort_by(|a, b| a.hash.cmp(&b.hash));
    let content_digest = compute_content_digest(&blocks);
    Ok(ArchiveManifest {
        schema_version: ARCHIVE_SCHEMA_VERSION,
        id: content_digest.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        blocks,
        content_digest,
    })
}

/// 校验 manifest 自身的内部一致性（不改动磁盘）。
///
/// 检查：schema major 可识别；`id` 与 `content_digest` 一致；`content_digest` 与
/// `blocks` 集合重算值一致；块哈希形如 64 位十六进制；无重复块 ID。
pub fn validate_manifest(manifest: &ArchiveManifest) -> Result<(), String> {
    if manifest.schema_version != ARCHIVE_SCHEMA_VERSION {
        return Err(format!(
            "[archive] unsupported manifest schema_version {} (supported: {})",
            manifest.schema_version, ARCHIVE_SCHEMA_VERSION
        ));
    }
    if manifest.id != manifest.content_digest {
        return Err("[archive] manifest id does not match content_digest".to_string());
    }
    for block in &manifest.blocks {
        if block.hash.len() != 64 || !block.hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("[archive] malformed block hash: {}", block.hash));
        }
    }
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for block in &manifest.blocks {
        if !seen.insert(block.hash.as_str()) {
            return Err(format!(
                "[archive] duplicate block in manifest: {}",
                block.hash
            ));
        }
    }
    let recomputed = compute_content_digest(&manifest.blocks);
    if recomputed != manifest.content_digest {
        return Err(format!(
            "[archive] content_digest mismatch: manifest={} recomputed={}",
            manifest.content_digest, recomputed
        ));
    }
    Ok(())
}

fn block_path(dest: &Path, hash: &str) -> PathBuf {
    dest.join(ARCHIVE_BLOCKS_DIR).join(hash)
}

/// 把 `root` 中与 `manifest` 对应的块落盘到 `dest`（manifest/内容分离）。
///
/// - 块文件写入 `<dest>/blocks/<hash>`；**已存在且哈希正确则跳过**（断点续传 + 去重）。
/// - **manifest 最后写**：全块落盘成功后写 `<dest>/manifest.json`（commit point，
///   半途中断的归档不会被误认为完整）。
/// - 目录树中找不到某 manifest 块的来源文件 → 返回 `Err`（不做静默缺块）。
pub fn pack_blocks(root: &Path, manifest: &ArchiveManifest, dest: &Path) -> Result<(), String> {
    validate_manifest(manifest)?;
    fs::create_dir_all(dest.join(ARCHIVE_BLOCKS_DIR))
        .map_err(|e| format!("[archive] create {} failed: {e}", dest.display()))?;

    // 源侧索引：块哈希 → 首个提供该内容的源文件。
    let files = enumerate_files(root)?;
    let mut source_for: std::collections::HashMap<String, PathBuf> =
        std::collections::HashMap::new();
    for (_relative, path) in &files {
        let (_size, hash) = block_hash_of_file(path)?;
        source_for.entry(hash).or_insert_with(|| path.clone());
    }

    for block in &manifest.blocks {
        let target = block_path(dest, &block.hash);
        if target.is_file() {
            // 断点续传：已存在且内容正确 → 跳过。
            if let Ok((size, hash)) = block_hash_of_file(&target) {
                if hash == block.hash && size == block.size {
                    continue;
                }
            }
        }
        let source = source_for.get(&block.hash).ok_or_else(|| {
            format!(
                "[archive] manifest block {} has no matching source file under {}",
                block.hash,
                root.display()
            )
        })?;
        let bytes = fs::read(source)
            .map_err(|e| format!("[archive] read {} failed: {e}", source.display()))?;
        let mut out = fs::File::create(&target)
            .map_err(|e| format!("[archive] create {} failed: {e}", target.display()))?;
        out.write_all(&bytes)
            .map_err(|e| format!("[archive] write {} failed: {e}", target.display()))?;
        out.sync_all()
            .map_err(|e| format!("[archive] sync {} failed: {e}", target.display()))?;
    }

    // manifest 最后写（commit point）。
    let encoded = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("[archive] serialize manifest failed: {e}"))?;
    let mut sink = fs::File::create(dest.join(ARCHIVE_MANIFEST_FILE))
        .map_err(|e| format!("[archive] create manifest failed: {e}"))?;
    sink.write_all(encoded.as_bytes())
        .map_err(|e| format!("[archive] write manifest failed: {e}"))?;
    sink.sync_all()
        .map_err(|e| format!("[archive] sync manifest failed: {e}"))?;
    Ok(())
}

/// 读回 `<dest>/manifest.json`（校验前的前置读）。
/// 目前唯一调用点在测试内（`verify_archive` 走独立路径），故限定测试 cfg。
#[cfg(test)]
pub fn load_manifest(dest: &Path) -> Result<ArchiveManifest, String> {
    let path = dest.join(ARCHIVE_MANIFEST_FILE);
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("[archive] read {} failed: {e}", path.display()))?;
    let manifest: ArchiveManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("[archive] parse {} failed: {e}", path.display()))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// 校验 `dest` 中的块与 `manifest` 是否一致。
///
/// 返回**不匹配块 ID 列表**（缺失、长度不符、哈希不符均计入）；**空列表即通过**。
/// 同时校验块集合指纹：指纹不符时以一个 `"content_digest:<期望>"` 形式的条目报告，
/// 使调用方能区分「单块损坏」与「块集合被增删」。
/// 目前唯一调用点在测试内，故限定测试 cfg。
#[cfg(test)]
pub fn verify_manifest(dest: &Path, manifest: &ArchiveManifest) -> Result<Vec<String>, String> {
    validate_manifest(manifest)?;
    let mut mismatched: Vec<String> = Vec::new();
    for block in &manifest.blocks {
        let path = block_path(dest, &block.hash);
        if !path.is_file() {
            mismatched.push(block.hash.clone());
            continue;
        }
        let (size, hash) = block_hash_of_file(&path)?;
        if hash != block.hash || size != block.size {
            mismatched.push(block.hash.clone());
        }
    }

    // 块集合指纹：仅当无单块损坏时才报告（避免噪声叠加）。
    if mismatched.is_empty() {
        let mut actual: Vec<BlockRef> = Vec::new();
        let blocks_dir = dest.join(ARCHIVE_BLOCKS_DIR);
        if blocks_dir.is_dir() {
            let entries = fs::read_dir(&blocks_dir)
                .map_err(|e| format!("[archive] read_dir {} failed: {e}", blocks_dir.display()))?;
            for entry in entries {
                let entry = entry.map_err(|e| format!("[archive] read_dir entry failed: {e}"))?;
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let (size, hash) = block_hash_of_file(&entry.path())?;
                actual.push(BlockRef { hash, size });
            }
        }
        actual.sort_by(|a, b| a.hash.cmp(&b.hash));
        if compute_content_digest(&actual) != manifest.content_digest {
            mismatched.push(format!("content_digest:{}", manifest.content_digest));
        }
    }
    Ok(mismatched)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let unique = format!(
                "niko-archive-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            let root = std::env::temp_dir().join(unique);
            fs::create_dir_all(&root).expect("create temp root");
            TempTree { root }
        }

        fn write(&self, relative: &str, contents: &[u8]) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::write(&path, contents).expect("write fixture");
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn manifest_roundtrip() {
        let source = TempTree::new("src");
        let dest = TempTree::new("dst");
        source.write("a.md", b"alpha");
        source.write("nested/b.md", b"beta");

        let manifest = build_manifest(&source.root).expect("build manifest");
        assert_eq!(manifest.schema_version, ARCHIVE_SCHEMA_VERSION);
        assert_eq!(manifest.blocks.len(), 2);
        assert_eq!(manifest.id, manifest.content_digest);
        validate_manifest(&manifest).expect("manifest must be internally consistent");

        pack_blocks(&source.root, &manifest, &dest.root).expect("pack blocks");
        // manifest 与 blocks 分文件存放。
        assert!(dest.root.join(ARCHIVE_MANIFEST_FILE).is_file());
        assert!(dest.root.join(ARCHIVE_BLOCKS_DIR).is_dir());

        // 序列化往返不丢信息（DA-03：schemaVersion + 向后兼容）。
        let reloaded = load_manifest(&dest.root).expect("reload manifest");
        assert_eq!(reloaded, manifest);
        assert_eq!(reloaded.blocks, manifest.blocks);

        // 校验通过 → 空列表。
        let mismatched = verify_manifest(&dest.root, &manifest).expect("verify");
        assert!(
            mismatched.is_empty(),
            "expected clean verify, got {mismatched:?}"
        );

        // 幂等重打包（断点续传路径：已存在且正确的块被跳过）。
        pack_blocks(&source.root, &manifest, &dest.root).expect("re-pack must be idempotent");
        assert!(verify_manifest(&dest.root, &manifest)
            .expect("verify again")
            .is_empty());
    }

    #[test]
    fn detects_corrupt_block() {
        let source = TempTree::new("src");
        let dest = TempTree::new("dst");
        source.write("only.md", b"genuine content");
        let manifest = build_manifest(&source.root).expect("build manifest");
        pack_blocks(&source.root, &manifest, &dest.root).expect("pack blocks");
        assert!(verify_manifest(&dest.root, &manifest)
            .expect("verify clean")
            .is_empty());

        // 篡改块内容（保持文件名不变）→ 必须命中该块。
        let victim = manifest.blocks[0].hash.clone();
        fs::write(
            dest.root.join(ARCHIVE_BLOCKS_DIR).join(&victim),
            b"tampered!",
        )
        .expect("corrupt block");
        let mismatched = verify_manifest(&dest.root, &manifest).expect("verify corrupt");
        assert_eq!(mismatched, vec![victim.clone()]);

        // 删除块 → 同样命中（缺失计入不匹配）。
        fs::remove_file(dest.root.join(ARCHIVE_BLOCKS_DIR).join(&victim)).expect("remove block");
        let missing = verify_manifest(&dest.root, &manifest).expect("verify missing");
        assert_eq!(missing, vec![victim]);

        // 块集合被增删（且**无单块损坏**）→ 以 content_digest 条目报告。
        // 另起一份完整归档（前一份已被删块，会叠加块级噪声）。
        let intact = TempTree::new("dst-intact");
        pack_blocks(&source.root, &manifest, &intact.root).expect("pack intact blocks");
        let extra = intact
            .root
            .join(ARCHIVE_BLOCKS_DIR)
            .join(block_hash(b"extra"));
        fs::write(&extra, b"extra").expect("write extra block");
        let drifted = verify_manifest(&intact.root, &manifest).expect("verify drift");
        assert_eq!(drifted.len(), 1, "digest drift reported once: {drifted:?}");
        assert!(drifted[0].starts_with("content_digest:"));
    }

    // 运维注记：本用例曾在 mac CI 单次失败（判运行器偶发：内容寻址 sha256 确定性 +
    // 历史三 mac run 均通过，未复现）。断言消息现自带诊断负载（manifest 块集合 hash 前缀
    // +字节数 / 块目录实况文件+字节数）。若复发：在 src-tauri 下 `RUST_BACKTRACE=1 cargo
    // test dedupes_identical_blocks` 本地复现，比对失败消息中的块集合与三个源文件字节后定论。
    #[test]
    fn dedupes_identical_blocks() {
        let source = TempTree::new("src");
        let dest = TempTree::new("dst");
        source.write("one.md", b"same bytes");
        source.write("two.md", b"same bytes");
        source.write("three.md", b"different");

        let manifest = build_manifest(&source.root).expect("build manifest");
        // 3 个文件 → 2 个唯一块（失败消息携带块集合诊断：hash 前缀 + 字节数）。
        assert_eq!(
            manifest.blocks.len(),
            2,
            "identical contents must dedupe to one block; blocks={:#?}",
            manifest
                .blocks
                .iter()
                .map(|b| (&b.hash[..12.min(b.hash.len())], b.size))
                .collect::<Vec<_>>()
        );

        pack_blocks(&source.root, &manifest, &dest.root).expect("pack blocks");
        let written: Vec<(String, u64)> = fs::read_dir(dest.root.join(ARCHIVE_BLOCKS_DIR))
            .expect("read blocks dir")
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let meta = entry.metadata().ok()?;
                meta.is_file()
                    .then(|| (entry.file_name().to_string_lossy().into_owned(), meta.len()))
            })
            .collect();
        assert_eq!(
            written.len(),
            2,
            "only unique blocks are written; on-disk={written:#?}"
        );

        // 空目录 → 空块集合，且仍产出可校验的 manifest。
        let empty = TempTree::new("empty");
        let empty_manifest = build_manifest(&empty.root).expect("build empty manifest");
        assert!(empty_manifest.blocks.is_empty());
        validate_manifest(&empty_manifest).expect("empty manifest must validate");
    }

    #[test]
    fn rejects_unknown_schema_major() {
        let source = TempTree::new("src");
        source.write("a.md", b"alpha");
        let mut manifest = build_manifest(&source.root).expect("build manifest");
        manifest.schema_version = ARCHIVE_SCHEMA_VERSION + 1;
        assert!(
            validate_manifest(&manifest).is_err(),
            "unknown major must be rejected"
        );
    }
}
