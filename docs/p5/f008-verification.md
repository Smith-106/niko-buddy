# F-008 PDF 导出——验证证据（TASK-008 verify 项四）

> 卡片要求：用导出的 PDF 渲染 1 页中文样本，人工核对字体嵌入与 1.5 行距，**不得以命令 exit 0 替代**。
> 本文逐项登记机械证据、可复现命令、以及**尚未由人完成**的部分。

## 1. 可复现产物

| 项 | 值 |
|---|---|
| 样本 PDF | `QMAI/docs/p5/f008-sample.pdf`（**生成物，不入库**：内嵌完整 CJK 字体后约 20 MB，已加入 `.gitignore`） |
| 生成命令 | `cd QMAI/src-tauri && cargo test --lib pdfexport::exports_cjk_sample_with_embedded_font` |
| 字体资产 | `QMAI/src-tauri/assets/fonts/NotoSerifCJKsc-Regular.otf`（24,543,080 bytes；**入库**，产品资产） |
| pdfium 运行时 | `QMAI/src-tauri/pdfium/pdfium.dll`（既有跟踪资产；测试靠 `pdfium_candidate_paths()` 的源码树候选自动发现，不注入环境变量） |

> 体积归因（实测）：样本 1 页、仅 2 段正文，但 `/FontFile` 流内嵌**完整**字体 → 约 20 MB。入库价值为零（一条命令可再生），且会把仓库推高 20 MB，故不入库；
> 字节级证据不依赖这个 blob：「字体已嵌入」由单测与 e2e 在**生成时**断言，样本文件本身只服务于人工目视。

## 2. 机械证据（已自动核验）

| 核验项 | 方法 | 结果 |
|---|---|---|
| 字体已**嵌入**而非仅被引用 | 读取产物字节，检索嵌入字体名 | PASS（字节流含 `NotoSerifCJKsc`） |
| 产物非空且尺寸合理 | `report.bytes_written` + `fs::metadata` | PASS（> 10,000 bytes） |
| 页数与回读一致 | pdfium 重新打开产物，比对 `doc.pages().len()` | PASS |
| 中文内容确实写入 | pdfium 回读第 1 页文本 | PASS（含「推开」「亮着」；见下方观察） |
| 行距固定 1.5 | 常量断言 `LINE_HEIGHT_RATIO == 1.5`、`11pt × 1.5 == 16.5pt`、折行确定性 | PASS |
| **渲染后的实际行距 = 16.5pt** | 新增：pdfium 渲染 → 逐行墨迹剖面 → 行带质心换算为 pt（测的是**像素**，不是常量） | PASS（见 §2.1） |
| **渲染产物确为黑字白底** | 渲染 PNG 灰度直方图 | PASS（背景 255、最暗 0、深色像素 7802） |
| 数据区路径被拒 | `rejects_path_inside_novel` / `rejects_path_inside_qm` / `.qmai` / `backups` / `..` | PASS（5 个用例） |

## 2.1 渲染像素量测（新增，2 倍缩放渲染）

命令：`cd QMAI/src-tauri && cargo test --lib pdfexport -- --nocapture`

| 量测对象 | 命令来源 | 实测值 | 结论 |
|---|---|---|---|
| 交付样本（3 个**单行**段落）的段间距 | `renders_sample_page_and_measures_line_spacing` | `32.99, 32.99` pt | PASS：= 2 × 16.5pt（1.5 行距 + 段间空一行） |
| **折行段落**的段内行距（132 字 → 4 行） | `wrapped_lines_keep_one_point_five_leading` | `16.54, 16.51, 16.88` pt | PASS：≈ 16.5pt（11pt × 1.5），容差 ±0.8pt |
| 渲染图是否真含文字 | 灰度直方图 | 背景 255 / 最暗 0 / 深色像素 7802 | PASS：纯白底 + 纯黑字 |

产物（均为**生成物，不入库**，已加入 `.gitignore`）：

- 整页 2 倍渲染图 `QMAI/docs/p5/f008-sample-p1.png`（1190 × 1684 px，36,309 bytes）
- 首行放大裁剪 `QMAI/docs/p5/f008-sample-p1-line1.png`（约 1190 × 48 px，7,975 bytes）——供人工/多模态无需缩放即可看清

> 重要修正（本轮实测发现）：交付样本每段只有**一行**，所以它能量测到的是**段间距 33pt**；判据要求的「段内 1.5 行距 16.5pt」在该样本上**根本无法被观测**。因此另建折行量测用例（临时 PDF，不入库）专门测段内行距。若只跑旧用例，会得到一个「看起来通过但没测到目标量」的假证据。

## 3. 本次发现（真实观察，已记入经验）

**pdfium + Noto Serif CJK 的文本回读会把部分汉字映射为康熙部首等价码位**：

| 原字 | 回读码位 | 字形 |
|---|---|---|
| 舟 U+821F | U+2F88（KANGXI RADICAL BOAT） | 相同 |
| 门 U+95E8 | U+2ED4（CJK RADICAL GATE） | 相同 |
| 色 U+8272 | U+2F8A | 相同 |
| 里 U+91CC | U+2F8B | 相同 |

影响面：**只影响复制/检索**（回读文本），不影响页面视觉与 PDF 可读性。做法：单测按「未受影响字形 + 长度量级」断言，并在测试内注明该映射；下游若要把 PDF 文本用于检索，应先做康熙部首归一化（NFKC 或等价映射表）。

## 4. 尚未由人完成的部分（不得视为已通过）

- **视觉核对（截至本轮仍未完成）**：单页中文样本的字形正确性与 1.5 行距的**目视**确认尚需人工在
  `docs/p5/f008-sample.pdf`（或渲染图 `f008-sample-p1.png`）上完成。
  本轮尝试过三条自动化视觉通路，**全部因环境原因失败**，故本条**不计**为通过：
  1. 本机多模态助手（`describe_image`）：路径解析正常（文件不存在时会报 ENOENT），但对存在的 PNG 图
     两次均返回「没有收到图片」——图片附件管道未把像素送达模型。
  2. 视觉能力队友（`glm-5.3-flash`，[vision]）：6 次工具调用全部 `Permission relay send-failed: write EPIPE`，
     连 `ls` 都无法执行（与本次移植分析阶段同一环境故障）；该队友**明确拒绝编造**图像内容，此处如实记录。
  3. 外部 CLI 委派（`maestro delegate --to gemini`）：实际路由到 codex，上游 6 次重试全部 `503 Service
     Unavailable`，输出为空。

  结论：字形/缺字/跨阅读器的**视觉**判定仍归用户；本轮只交付**像素级机械证据**（§2.1）与**可直接目视的素材**。
  不得以「自动化已跑」替代人工目视。
- **跨阅读器核对**：未在 Acrobat / 福昕 / 浏览器内置阅读器等第三方渲染器上逐一体检。
