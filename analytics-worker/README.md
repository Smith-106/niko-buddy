# Niko Buddy Analytics Worker

接收桌面客户端的匿名在线统计（`/open`、`/heartbeat`、`/close`）、用户反馈（`/feedback`）与健康检查（`/health`），存储于 Cloudflare D1 数据库 `qmai-analytics-db`。

## 配置说明

- `wrangler.toml`：`name = "niko-buddy-analytics"`（与客户端默认端点 `https://niko-buddy-analytics.niko-buddy.workers.dev` 对齐）
- 绑定 D1：`database_name = "qmai-analytics-db"`，`database_id = "884bb0bb-c024-4cff-b062-b3b4e783a5cf"`（保持已有实例不变）

## 部署与线上验收命令

需先完成 Cloudflare CLI 登录或配置 `CLOUDFLARE_API_TOKEN` 环境变量：

```bash
cd analytics-worker
npm ci
npx wrangler login
npm run deploy
```

部署完成后执行健康探针验证：

```bash
curl -fsS https://niko-buddy-analytics.niko-buddy.workers.dev/health
```

若需要覆盖桌面客户端测试端点，可在构建前端时设置环境变量 `VITE_ANALYTICS_URL`。
