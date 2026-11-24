#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJxaDriver } from "./driver/jxa-driver.js";
import { unattendedFromEnv } from "./gate/gate.js";
import { runCli } from "./cli.js";
import { installProcessGuards } from "./guards.js";
import { createSafariServer } from "./server.js";

/** 닫기가 이 시간 안에 안 끝나면(코드가 이벤트 루프를 막은 경우 등) 그냥 끝낸다. */
const SHUTDOWN_MS = 8000;

/** MCP 서버로 동작한다(표준입출력). */
async function serve(): Promise<void> {
  const driver = createJxaDriver({ unattended: unattendedFromEnv(process.env) });
  const { server, shutdown, handleStray } = createSafariServer(driver);

  let closing = false;
  const stop = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    const bail = setTimeout(() => process.exit(code), SHUTDOWN_MS);
    bail.unref();
    try {
      await shutdown(); // 우리가 연 탭을 닫는다
      await driver.close();
    } catch (e) {
      console.error("[safari-attraction] 닫는 중 오류:", e);
    }
    process.exit(code);
  };

  // Claude 가 쓴 코드의 거부 · 오류 하나로 서버가 죽지 않게 한다(죽으면 우리가 연 탭도 남는다).
  installProcessGuards(process, { handleStray, stop, log: (msg, err) => console.error(msg, err) });

  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  process.stdin.on("end", () => void stop(0));
  process.stdin.on("close", () => void stop(0));

  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const out = (s: string) => void process.stdout.write(s + "\n");
  const err = (s: string) => void process.stderr.write(s + "\n");
  const code = await runCli(
    process.argv.slice(2),
    { stdout: out, stderr: err, stdinIsTTY: Boolean(process.stdin.isTTY) },
    // 묶음(plugin/server.mjs)에서는 이 파일이 곧 server.mjs, dist 에서는 dist/src/index.js.
    { selfPath: fileURLToPath(import.meta.url) },
  );
  if (code === "serve") return serve();
  // 드라이버를 닫았으니 스스로 끝나게 두고, 코드만 정한다(파이프로 나가는 글이 잘리지 않게).
  process.exitCode = code;
}

main().catch((e) => {
  console.error("[safari-attraction] 시작하지 못함:", e);
  process.exit(1);
});
