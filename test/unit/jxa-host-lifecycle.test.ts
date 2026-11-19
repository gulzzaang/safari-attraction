import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { JxaHost } from "../../src/driver/jxa-host.js";

// 사파리를 건드리지 않는다(ping 만). JXA 호스트가 stdin 이 닫히면 스스로 끝나는지 — NSData.length 비교가 어긋나
// 영영 안 끝나고 CPU 를 먹던 일(마지막 검토 C1)을 막는다. macOS 에서만 돈다.
const HOST = fileURLToPath(new URL("../../src/driver/jxa/host.js", import.meta.url));
const mac = process.platform === "darwin";

describe.skipIf(!mac)("JXA 호스트 수명(사파리 없이)", () => {
  test("JxaHost: ping 뒤 close() 가 강제로 죽이지 않고 바로(1초 안에) 끝난다", async () => {
    const host = new JxaHost(10_000);
    expect(await host.call("ping")).toBe("pong");
    const child = (host as unknown as { child: { pid: number; exitCode: number | null; signalCode: string | null; once: Function } }).child;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("exit", (code: number | null, signal: string | null) => resolve({ code, signal })),
    );
    const t0 = Date.now();
    await host.close();
    const r = await exited;
    expect(r).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(900);
  }, 15_000);

  test("호스트가 떠 있는 동안만 process 'exit' 귀가 하나 늘고, 끝나면 되돌아온다(누수 없음)", async () => {
    const base = process.listenerCount("exit");
    const host = new JxaHost(10_000);
    await host.call("ping");
    expect(process.listenerCount("exit")).toBe(base + 1);
    await host.close();
    expect(process.listenerCount("exit")).toBe(base);
  }, 15_000);

  test("호스트를 직접 띄워 stdin 만 닫으면 스스로 끝난다(kill 없이, 코드 0)", async () => {
    const child = spawn("osascript", ["-l", "JavaScript", HOST], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    child.stdin.write(JSON.stringify({ id: 1, op: "ping", args: {} }) + "\n");
    const deadline = Date.now() + 8000;
    while (!out.includes("pong") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(out).toContain("pong");
    const t0 = Date.now();
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000); // 시험이 매달리지 않게 하는 안전장치
    const r = await exited;
    clearTimeout(timer);
    expect(r).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 15_000);
});

describe("묶음이 소스와 같다", () => {
  test("plugin/jxa/host.js 는 src/driver/jxa/host.js 와 바이트까지 같다", () => {
    const rel = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url));
    expect(rel("plugin/jxa/host.js").equals(rel("src/driver/jxa/host.js"))).toBe(true);
  });

  test("plugin/server.mjs 는 지금 src/ 에서 다시 묶은 것과 같다(다르면 npm run build 후 함께 커밋)", () => {
    const script = fileURLToPath(new URL("../../scripts/check-bundle.sh", import.meta.url));
    expect(() => execFileSync("sh", [script], { stdio: "pipe", timeout: 60_000 })).not.toThrow();
  }, 70_000);
});
