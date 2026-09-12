// A-F-004 真机冒烟用的最小 WebDAV 靶端（本机真实 HTTP 服务）。
//
// 只实现同步链真正使用的三个原语：PUT / GET / PROPFIND。
// 它把「传输层是否真的在说 HTTP」变成可查证的事实：每个请求都以 JSONL 记录
// 方法、URL 路径、Authorization 头与字节数。
//
// 用法：node scripts/smoke-webdav-server.mjs <port> <dataDir> <logFile> [expectedBasic]
//   expectedBasic 形如 "smoke-user:smoke-pass"，用于断言 Basic 头确实送达。
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

const [portArg, dataDirArg, logFileArg, expectedBasic] = process.argv.slice(2);
const port = Number(portArg ?? 8792);
const dataDir = resolve(dataDirArg ?? ".smoke-webdav");
const logFile = resolve(logFileArg ?? "smoke-webdav.jsonl");
mkdirSync(dataDir, { recursive: true });

const expectedHeader = expectedBasic
  ? "Basic " + Buffer.from(expectedBasic, "utf8").toString("base64")
  : null;

function log(entry) {
  appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
}

function safePath(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const abs = resolve(join(dataDir, rel));
  if (abs !== dataDir && !abs.startsWith(dataDir + sep)) return null;
  return abs;
}

function walk(dir, base, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) walk(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const urlPath = (req.url ?? "/").split("?")[0];
    const abs = safePath(urlPath);
    const auth = req.headers["authorization"] ?? "";
    const base = `http://127.0.0.1:${port}`;

    const record = (status, extra = {}) => {
      log({
        method: req.method,
        path: urlPath,
        auth,
        bytes: body.length,
        status,
        ...extra,
      });
    };

    if (expectedHeader && req.method !== "PROPFIND" && auth !== expectedHeader) {
      res.writeHead(401).end("unauthorized");
      record(401, { reason: "auth_mismatch" });
      return;
    }
    if (!abs) {
      res.writeHead(400).end("bad path");
      record(400);
      return;
    }

    if (req.method === "PUT") {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      res.writeHead(201).end();
      record(201);
      return;
    }

    if (req.method === "GET") {
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        res.writeHead(404).end("not found");
        record(404);
        return;
      }
      const bytes = readFileSync(abs);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }).end(bytes);
      record(200);
      return;
    }

    if (req.method === "PROPFIND") {
      const prefix = urlPath.replace(/^\/+/, "");
      const keys = walk(dataDir, "", []).filter((rel) => rel === prefix || rel.startsWith(prefix + "/"));
      const hrefs = keys
        .map((rel) => `  <D:response><D:href>${base}/${rel}</D:href></D:response>`)
        .join("\n");
      const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${hrefs}\n</D:multistatus>\n`;
      res.writeHead(207, { "content-type": "application/xml; charset=utf-8" }).end(xml);
      record(207, { objects: keys.length });
      return;
    }

    res.writeHead(405).end("method not allowed");
    record(405);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[smoke-webdav] listening on http://127.0.0.1:${port} dataDir=${dataDir} log=${logFile}`);
});
