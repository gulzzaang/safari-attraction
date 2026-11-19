#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJxaDriver } from "./driver/jxa-driver.js";
import { installProcessGuards } from "./guards.js";
import { createSafariServer } from "./server.js";

/** 닫기가 이 시간 안에 안 끝나면(코드가 이벤트 루프를 막은 경우 등) 그냥 끝낸다. */
const SHUTDOWN_MS = 8000;

async function main(): Promise<void> {
  const driver = createJxaDriver();
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

main().catch((e) => {
  console.error("[safari-attraction] 시작하지 못함:", e);
  process.exit(1);
});
