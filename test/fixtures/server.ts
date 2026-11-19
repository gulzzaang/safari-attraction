import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "pages");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** 127.0.0.1 임의 포트에서(localhost 로 불러도 닿는다) test/fixtures/pages 를 정적으로 내준다. */
export async function startFixtureServer(): Promise<{ baseUrl: string; altBaseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = normalize(join(PAGES_DIR, path));
    if (!file.startsWith(PAGES_DIR + "/")) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    // 같은 서버를 다른 호스트 이름으로 부른다 — 출처가 달라 다른 출처 iframe 시험에 쓴다(둘 다 이 맥 안쪽 주소다).
    altBaseUrl: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
