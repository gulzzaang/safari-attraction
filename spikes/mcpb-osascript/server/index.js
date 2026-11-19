// 시험 A: 의존성 없는 최소 MCP 서버(stdio, 줄 단위 JSON-RPC). 도구는 ping_safari 하나.
import { execFile } from "node:child_process";
import readline from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

function pingSafari() {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", 'Application("Safari").windows.length'],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          windows: stdout ? stdout.trim() : null,
          error: err ? String(err.message) : null,
          stderr: stderr ? stderr.trim() : null,
          nodeVersion: process.version,
          execPath: process.execPath,
        });
      },
    );
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "safari-attraction-spike", version: "0.0.1" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0", id,
      result: {
        tools: [{
          name: "ping_safari",
          description: "osascript 로 사파리 창 개수를 읽고 내장 Node 판 · 경로를 돌려준다.",
          inputSchema: { type: "object", properties: {} },
        }],
      },
    });
  } else if (method === "tools/call") {
    const r = await pingSafari();
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: !r.ok } });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
