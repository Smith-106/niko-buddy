//! EPIC-001 / TASK-005 / ADR-29: Style exemplar 标记 command（Rust 侧）。
//!
//! UI 经 `mark_style_exemplar` Tauri command 在 Rust 侧直接读写
//! `.novel/style-exemplars.json`（read-modify-write + serde_json），与 TS 侧
//! `markStyleExemplar`（style-exemplars-loader.ts，供 contextPack 注入用）
//! 逻辑镜像 — 两端读写同一文件，HARD-1 真源是 `.novel/style-exemplars.json`
//! 文件本身。
//!
//! HARD-2 Draft-first 例外（C-001 决议，ADR-29）：exemplar 是用户主动标记
//! 非 AI 产出，直写正式层 `.novel/style-exemplars.json`，不经 pending→accept
//! 流程。UI 须明确标注「用户标记锚点」非自动生成。
//!
//! PAT-DC1（CWE-532 日志脱敏）：损坏 JSON 抛脱敏异常（`style exemplars file
//! is corrupt`），不暴露 raw JSON 内容或文件路径。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::commands::file_sync;

/// exemplar 标记类型枚举（PAT-G2 镜像：与 TS VALID_MARK_TYPES 一致）。
const VALID_MARK_TYPES: &[&str] = &["style", "voice", "pacing"];

/// exemplar 标记输入负载（UI → Rust）。
///
/// `mark_type` 在 Rust 侧做枚举校验（镜像 TS `assertValidMarkType`），
/// 非法值返回 `Err`，防止 twin loader 漏检模式（PAT-G2）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkStyleExemplarInput {
    pub chapter_id: String,
    pub text: String,
    pub mark_type: String,
    pub note: Option<String>,
}

/// style exemplar 单条记录（Rust 侧镜像 TS `StyleExemplar`）。
///
/// `exemplar_id` 用 `uuid::Uuid::new_v4()` 生成（与 TS `crypto.randomUUID`
/// 等价的 v4 UUID）。`created_at` 用 ISO-8601 UTC 串（与 TS
/// `new Date().toISOString()` 一致）。
///
/// FIX-2/EC-1 双格式兼容：`id`/`marked_at` 为 v1.0 版式别名字段（serde alias），
/// 读取时自动映射到 `exemplar_id`/`created_at`；写入始终输出新格式字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleExemplarRecord {
    #[serde(alias = "id")]
    pub exemplar_id: String,
    pub chapter_id: String,
    pub text: String,
    pub mark_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(alias = "markedAt")]
    pub created_at: String,
}

/// v1.0 包装对象形状（FIX-2/EC-1）：`{$schema, exemplars: [...]}`。
#[derive(Debug, Deserialize)]
struct WrappedExemplars {
    exemplars: Vec<StyleExemplarRecord>,
}

/// 校验 markType 枚举值。非法值返回脱敏 `Err`（PAT-G2 镜像）。
fn validate_mark_type(mark_type: &str) -> Result<(), String> {
    if VALID_MARK_TYPES.contains(&mark_type) {
        Ok(())
    } else {
        Err(format!("invalid markType: {}", mark_type))
    }
}

/// `.novel/style-exemplars.json` 文件路径（项目根 → 文件）。
fn exemplars_file_path(project_path: &str) -> String {
    let normalized = project_path.replace('\\', "/");
    format!("{normalized}/.novel/style-exemplars.json")
}

/// Core logic for `mark_style_exemplar`, callable from both Tauri commands
/// and Axum handlers.
///
/// read-modify-write：读现有 exemplars（缺失/损坏视为空列表，重建存储），
/// append 新条目（`exemplar_id` = v4 UUID），原子写回。
///
/// 损坏文件不抛错是因为用户标记是显式意图，重建是安全降级（与 TS
/// `markStyleExemplar` 的损坏降级语义一致：load 是被动消费抛错，mark 是
/// 主动写入重建）。
pub fn do_mark_style_exemplar(
    project_path: &str,
    mark: &MarkStyleExemplarInput,
) -> Result<(), String> {
    validate_mark_type(&mark.mark_type)?;

    let file_path = exemplars_file_path(project_path);
    let p = Path::new(&file_path);

    // read-modify-write：读取现有 exemplars（缺失/损坏 → 空列表重建）。
    // FIX-2/EC-1：双格式兼容——裸数组与 {$schema, exemplars:[...]} 包装都解包；
    // 合法包装对象不得触发重建覆盖（F2 数据丢失修复）。
    let mut existing: Vec<StyleExemplarRecord> = Vec::new();
    if let Ok(raw) = fs::read_to_string(p) {
        if let Ok(parsed) = serde_json::from_str::<Vec<StyleExemplarRecord>>(&raw) {
            existing = parsed;
        } else if let Ok(wrapped) = serde_json::from_str::<WrappedExemplars>(&raw) {
            existing = wrapped.exemplars;
        }
        // 真正损坏 JSON（两种形状都解析失败）— 视为空列表重建（不阻断用户标记，与 TS 语义一致）。
    }
    // 文件缺失 — existing 保持空 Vec。

    let exemplar = StyleExemplarRecord {
        exemplar_id: uuid::Uuid::new_v4().to_string(),
        chapter_id: mark.chapter_id.clone(),
        text: mark.text.clone(),
        mark_type: mark.mark_type.clone(),
        note: mark.note.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    existing.push(exemplar);

    // 创建 .novel/ 目录（若不存在）。
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .novel dir: {}", e))?;
    }

    let contents = serde_json::to_string_pretty(&existing)
        .map_err(|e| format!("Failed to serialize exemplars: {}", e))?;

    // 标记 app 写路径（file_sync 热重载协调）+ 写盘。
    file_sync::mark_app_write_path(p);
    fs::write(p, &contents)
        .map_err(|e| format!("Failed to write style exemplars file: {}", e))?;
    file_sync::mark_app_write_path(p);

    Ok(())
}

/// EPIC-001 / TASK-005: 标记一段文本为 style exemplar 并持久化
/// （Draft-first 例外 C-001，直写正式层 `.novel/style-exemplars.json`）。
///
/// Rust 侧直接 read-modify-write（与 TS loader 镜像），UI 经
/// `@/commands/exemplar` wrapper invoke 此 command。
#[tauri::command]
pub async fn mark_style_exemplar(
    project_path: String,
    mark: MarkStyleExemplarInput,
) -> Result<(), String> {
    let pp = project_path.clone();
    let mk = mark.clone();
    tauri::async_runtime::spawn_blocking(move || do_mark_style_exemplar(&pp, &mk))
        .await
        .map_err(|e| format!("mark_style_exemplar blocking task join error: {e}"))?
}

/// Core logic for `load_style_exemplars`, callable from both Tauri commands
/// and Axum handlers.
///
/// 缺失文件 → 返回空 Vec（优雅降级，项目未标记过 exemplar 是常态）。
/// 损坏 JSON → 抛脱敏异常（PAT-DC1：不暴露 raw JSON / 文件路径）。
pub fn do_load_style_exemplars(project_path: &str) -> Result<Vec<StyleExemplarRecord>, String> {
    let file_path = exemplars_file_path(project_path);
    let p = Path::new(&file_path);

    if !p.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(p).map_err(|e| format!("style exemplars file read error: {}", e))?;
    // FIX-2/EC-1：双格式兼容——裸数组优先，{$schema, exemplars:[...]} 包装次之，
    // 两者都不是才判 corrupt（PAT-DC1 脱敏，不暴露 raw JSON / 路径）。
    let parsed: Vec<StyleExemplarRecord> =
        match serde_json::from_str::<Vec<StyleExemplarRecord>>(&raw) {
            Ok(arr) => arr,
            Err(_) => match serde_json::from_str::<WrappedExemplars>(&raw) {
                Ok(wrapped) => wrapped.exemplars,
                Err(_) => return Err("style exemplars file is corrupt".to_string()),
            },
        };
    Ok(parsed)
}

/// EPIC-001 / TASK-005: 加载项目级 style exemplars（UI 计数显示用）。
#[tauri::command]
pub async fn load_style_exemplars(
    project_path: String,
) -> Result<Vec<StyleExemplarRecord>, String> {
    let pp = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || do_load_style_exemplars(&pp))
        .await
        .map_err(|e| format!("load_style_exemplars blocking task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_project_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qmai-exemplar-{}-{}",
            label,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn validate_mark_type_accepts_known_types() {
        assert!(validate_mark_type("style").is_ok());
        assert!(validate_mark_type("voice").is_ok());
        assert!(validate_mark_type("pacing").is_ok());
    }

    #[test]
    fn validate_mark_type_rejects_unknown_type() {
        let err = validate_mark_type("tone").unwrap_err();
        assert!(err.contains("invalid markType"));
        assert!(!err.contains("/.novel/")); // PAT-DC1: no path leak
    }

    #[test]
    fn do_mark_style_exemplar_creates_file_when_missing() {
        let dir = tmp_project_dir("create");
        let mark = MarkStyleExemplarInput {
            chapter_id: "ch-1".to_string(),
            text: "风穿过竹林".to_string(),
            mark_type: "style".to_string(),
            note: Some("good imagery".to_string()),
        };
        do_mark_style_exemplar(dir.to_str().unwrap(), &mark).unwrap();

        let loaded = do_load_style_exemplars(dir.to_str().unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].chapter_id, "ch-1");
        assert_eq!(loaded[0].mark_type, "style");
        assert_eq!(loaded[0].text, "风穿过竹林");
        assert!(loaded[0].exemplar_id.len() > 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_mark_style_exemplar_appends_to_existing() {
        let dir = tmp_project_dir("append");
        let mark1 = MarkStyleExemplarInput {
            chapter_id: "ch-1".to_string(),
            text: "第一段".to_string(),
            mark_type: "style".to_string(),
            note: None,
        };
        let mark2 = MarkStyleExemplarInput {
            chapter_id: "ch-2".to_string(),
            text: "第二段".to_string(),
            mark_type: "voice".to_string(),
            note: None,
        };
        do_mark_style_exemplar(dir.to_str().unwrap(), &mark1).unwrap();
        do_mark_style_exemplar(dir.to_str().unwrap(), &mark2).unwrap();

        let loaded = do_load_style_exemplars(dir.to_str().unwrap()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1].chapter_id, "ch-2");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_mark_style_exemplar_rejects_invalid_mark_type() {
        let dir = tmp_project_dir("reject");
        let mark = MarkStyleExemplarInput {
            chapter_id: "ch-1".to_string(),
            text: "x".to_string(),
            mark_type: "tone".to_string(),
            note: None,
        };
        let err = do_mark_style_exemplar(dir.to_str().unwrap(), &mark).unwrap_err();
        assert!(err.contains("invalid markType"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_mark_style_exemplar_recovers_from_corrupt_file() {
        let dir = tmp_project_dir("corrupt");
        fs::create_dir_all(dir.join(".novel")).unwrap();
        fs::write(dir.join(".novel/style-exemplars.json"), "{not json").unwrap();

        let mark = MarkStyleExemplarInput {
            chapter_id: "ch-1".to_string(),
            text: "x".to_string(),
            mark_type: "style".to_string(),
            note: None,
        };
        // 损坏文件 → 重建（不阻断用户标记）。
        do_mark_style_exemplar(dir.to_str().unwrap(), &mark).unwrap();
        let loaded = do_load_style_exemplars(dir.to_str().unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_load_style_exemplars_returns_empty_when_missing() {
        let dir = tmp_project_dir("empty");
        let loaded = do_load_style_exemplars(dir.to_str().unwrap()).unwrap();
        assert!(loaded.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_load_style_exemplars_corrupt_throws_sanitized_error() {
        let dir = tmp_project_dir("corrupt-load");
        fs::create_dir_all(dir.join(".novel")).unwrap();
        fs::write(dir.join(".novel/style-exemplars.json"), "{not json").unwrap();

        let err = do_load_style_exemplars(dir.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "style exemplars file is corrupt");
        // PAT-DC1: no raw JSON / file path leak
        assert!(!err.contains("{not"));
        assert!(!err.contains("/.novel/"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_load_style_exemplars_unwraps_wrapped_object_with_aliases() {
        let dir = tmp_project_dir("wrapped-load");
        fs::create_dir_all(dir.join(".novel")).unwrap();
        fs::write(
            dir.join(".novel/style-exemplars.json"),
            r#"{"$schema":"https://example.test/style-exemplars.schema.json","exemplars":[
                {"id":"EX-001","chapterId":"ch1","text":"种子段落 1","markType":"style","note":"n","markedAt":"2026-07-10T00:00:00Z"},
                {"id":"EX-002","chapterId":"ch1","text":"种子段落 2","markType":"voice","markedAt":"2026-07-10T00:01:00Z"}
            ]}"#,
        )
        .unwrap();

        let loaded = do_load_style_exemplars(dir.to_str().unwrap()).unwrap();
        assert_eq!(loaded.len(), 2);
        // 字段别名映射：id→exemplar_id、markedAt→created_at
        assert_eq!(loaded[0].exemplar_id, "EX-001");
        assert_eq!(loaded[0].created_at, "2026-07-10T00:00:00Z");
        assert_eq!(loaded[1].exemplar_id, "EX-002");
        assert_eq!(loaded[1].created_at, "2026-07-10T00:01:00Z");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_mark_style_exemplar_appends_to_wrapped_file_without_overwrite() {
        let dir = tmp_project_dir("wrapped-append");
        fs::create_dir_all(dir.join(".novel")).unwrap();
        fs::write(
            dir.join(".novel/style-exemplars.json"),
            r#"{"$schema":"https://example.test/style-exemplars.schema.json","exemplars":[
                {"id":"EX-001","chapterId":"ch1","text":"种子段落 1","markType":"style","markedAt":"2026-07-10T00:00:00Z"}
            ]}"#,
        )
        .unwrap();

        let mark = MarkStyleExemplarInput {
            chapter_id: "ch-2".to_string(),
            text: "新段落".to_string(),
            mark_type: "pacing".to_string(),
            note: None,
        };
        do_mark_style_exemplar(dir.to_str().unwrap(), &mark).unwrap();

        let loaded = do_load_style_exemplars(dir.to_str().unwrap()).unwrap();
        // 1 条种子 + 1 条新增 = 2，不得被重建覆盖为 1。
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].exemplar_id, "EX-001");
        assert_eq!(loaded[1].mark_type, "pacing");
        let _ = fs::remove_dir_all(&dir);
    }
}
