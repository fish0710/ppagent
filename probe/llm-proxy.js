#!/usr/bin/env node
// llm-proxy.js <upstream-base-url> — 本地反向代理，屏蔽「服务端拒绝非 node TLS 栈」的环境约束。
//
// 适用场景：远端模型网关（如 omlx）做 TLS 指纹防护，只放行 node/浏览器的握手，
// curl / python urllib 全部 Connection reset。而 ppagent 本体就是 node，能通。
// 于是让所有非 node 客户端打本地代理（无 TLS），代理用 node fetch 转发到 upstream。
//
// 用法（通常由 run_probe.sh 拉起）：
//   node llm-proxy.js https://omlx.wieimmer.asia:8443/v1
// 监听 127.0.0.1 随机端口，把端口号打印到 stdout 第一行。
import http from "node:http";

const upstream = process.argv[2];
if (!upstream) {
  console.error("usage: node llm-proxy.js <upstream-base-url>");
  process.exit(2);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = upstream.replace(/\/+$/, "") + req.url;
    const headers = {};
    for (const h of ["content-type", "authorization", "accept", "user-agent"]) {
      const v = req.headers[h];
      if (v) headers[h] = v;
    }
    fetch(url, {
      method: req.method,
      headers,
      body,
      duplex: body ? "half" : undefined,
    })
      .then(async (r) => {
        res.writeHead(r.status, Object.fromEntries(r.headers));
        if (r.body) {
          for await (const c of r.body) res.write(c);
        }
        res.end();
      })
      .catch((e) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("proxy upstream error: " + (e && e.message));
      });
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
});
