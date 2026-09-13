# Tauri 命令参考（自动生成）

> 生成时间：2026-09-13（脚本 `scripts/gen-tauri-commands-doc.mjs`，68 号 P2-12 / C2）
> 注册数：**110**（`generate_handler!` 块）；未注册声明（死命令）：**1**

## 注册命令（110）

| 命令 | 模块 | 注册 |
|------|------|------|
| `confirm_gate_classify` | agent_gate | ✓ |
| `confirm_gate_loop_state` | agent_gate | ✓ |
| `confirm_gate_pending` | agent_gate | ✓ |
| `confirm_gate_resolve` | agent_gate | ✓ |
| `app_lock_set_passphrase` | app_lock::api | ✓ |
| `app_lock_state` | app_lock::api | ✓ |
| `app_lock_verify` | app_lock::api | ✓ |
| `cancel_backup` | backup | ✓ |
| `export_backup` | backup | ✓ |
| `import_backup` | backup | ✓ |
| `batch_replace_apply` | batch_replace::api | ✓ |
| `batch_replace_preview` | batch_replace::api | ✓ |
| `canon_facts_known_by` | canon::commands | ✓ |
| `canon_get_revision` | canon::commands | ✓ |
| `canon_ingest_episode` | canon::commands | ✓ |
| `canon_load_divergence_trace` | canon::commands | ✓ |
| `canon_query` | canon::commands | ✓ |
| `canon_query_batch` | canon::commands | ✓ |
| `canon_query_episodes` | canon::commands | ✓ |
| `canon_save_divergence_trace` | canon::commands | ✓ |
| `canon_supersede_edges` | canon::commands | ✓ |
| `canon_auto_backup` | canon::export | ✓ |
| `canon_export_project` | canon::export | ✓ |
| `canon_restore_project` | canon::export | ✓ |
| `canon_verify_export` | canon::export | ✓ |
| `claude_cli_detect` | claude_cli | ✓ |
| `claude_cli_kill` | claude_cli | ✓ |
| `claude_cli_spawn` | claude_cli | ✓ |
| `claude_cli_terminate` | claude_cli | ✓ |
| `codex_cli_detect` | codex_cli | ✓ |
| `codex_cli_kill` | codex_cli | ✓ |
| `codex_cli_spawn` | codex_cli | ✓ |
| `vault_delete_secret` | credential_vault::api | ✓ |
| `vault_get_secret` | credential_vault::api | ✓ |
| `vault_has_secret` | credential_vault::api | ✓ |
| `vault_put_secret` | credential_vault::api | ✓ |
| `get_device_fingerprint_cmd` | crypto | ✓ |
| `cursor_cli_detect` | cursor_cli | ✓ |
| `cursor_proxy_ensure` | cursor_cli | ✓ |
| `cursor_proxy_status` | cursor_cli | ✓ |
| `cursor_proxy_stop` | cursor_cli | ✓ |
| `export_novel_docx` | docx_export | ✓ |
| `export_novel_epub` | epub_export | ✓ |
| `delete_style_exemplar` | exemplar_commands | ✓ |
| `load_style_exemplars` | exemplar_commands | ✓ |
| `mark_style_exemplar` | exemplar_commands | ✓ |
| `extract_and_save_office_images_cmd` | extract_images | ✓ |
| `extract_and_save_pdf_images_cmd` | extract_images | ✓ |
| `ignore_file_change_task` | file_sync | ✓ |
| `rescan_project_files` | file_sync | ✓ |
| `retry_file_change_task` | file_sync | ✓ |
| `start_project_file_watcher` | file_sync | ✓ |
| `stop_project_file_watcher` | file_sync | ✓ |
| `copy_directory` | fs | ✓ |
| `copy_file` | fs | ✓ |
| `create_directory` | fs | ✓ |
| `delete_file` | fs | ✓ |
| `file_exists` | fs | ✓ |
| `find_related_wiki_pages` | fs | ✓ |
| `get_executable_dir` | fs | ✓ |
| `get_file_md5` | fs | ✓ |
| `get_file_modified_time` | fs | ✓ |
| `get_file_size` | fs | ✓ |
| `get_resource_dir` | fs | ✓ |
| `list_directory` | fs | ✓ |
| `preprocess_file` | fs | ✓ |
| `read_file` | fs | ✓ |
| `read_file_as_base64` | fs | ✓ |
| `write_file` | fs | ✓ |
| `write_file_atomic` | fs | ✓ |
| `write_files_atomic` | fs | ✓ |
| `log_diagnostic` | log_diagnostic | ✓ |
| `mcp_remote_close` | mcp_remote::api | ✓ |
| `mcp_remote_connect` | mcp_remote::api | ✓ |
| `mcp_remote_request` | mcp_remote::api | ✓ |
| `mcp_transport_set_mode` | mcp_remote::api | ✓ |
| `mcp_stdio_kill` | mcp_stdio | ✓ |
| `mcp_stdio_read` | mcp_stdio | ✓ |
| `mcp_stdio_spawn` | mcp_stdio | ✓ |
| `mcp_stdio_write` | mcp_stdio | ✓ |
| `export_pdf` | pdf_export::api | ✓ |
| `acquire_wake_lock` | power | ✓ |
| `release_wake_lock` | power | ✓ |
| `create_project` | project | ✓ |
| `open_file_location` | project | ✓ |
| `open_project` | project | ✓ |
| `open_project_folder` | project | ✓ |
| `secret_available` | secret_store | ✓ |
| `secret_delete` | secret_store | ✓ |
| `secret_get` | secret_store | ✓ |
| `secret_put` | secret_store | ✓ |
| `skill_bundle_export` | skill_bundle | ✓ |
| `skill_bundle_import` | skill_bundle | ✓ |
| `skill_bundle_verify` | skill_bundle | ✓ |
| `snapshot_list_chain` | snapshot_timemachine | ✓ |
| `snapshot_preview_point` | snapshot_timemachine | ✓ |
| `snapshot_restore_atomic` | snapshot_timemachine | ✓ |
| `sync_configure` | sync_target | ✓ |
| `sync_conflicts` | sync_target | ✓ |
| `sync_pull` | sync_target | ✓ |
| `sync_push` | sync_target | ✓ |
| `sync_status` | sync_target | ✓ |
| `sync_test` | sync_target | ✓ |
| `vector_count_chunks` | vectorstore | ✓ |
| `vector_delete_page` | vectorstore | ✓ |
| `vector_drop_legacy` | vectorstore | ✓ |
| `vector_legacy_row_count` | vectorstore | ✓ |
| `vector_run_startup_reconcile` | vectorstore | ✓ |
| `vector_search_chunks` | vectorstore | ✓ |
| `vector_upsert_chunks` | vectorstore | ✓ |

## 死命令审计（声明未注册，1）

- `set_proxy_env` — src-tauri/src/lib.rs

## 再生成

```bash
node scripts/gen-tauri-commands-doc.mjs
node scripts/gen-tauri-commands-doc.mjs --check
```
