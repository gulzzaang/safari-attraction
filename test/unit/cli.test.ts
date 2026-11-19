import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { VERSION } from "../../src/version.js";
import { createFakeDriver } from "../helpers/fake-driver.js";
import { SafariError } from "../../src/driver/types.js";

function makeIo(stdinIsTTY: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s), stdinIsTTY } };
}

describe("명령줄(runCli)", () => {
  test("VERSION 은 0.1.0", () => {
    expect(VERSION).toBe("0.1.0");
  });

  test("인자 없음 + 터미널 → 도움말을 찍고 0 (서버가 멈춘 것처럼 보이지 않게)", async () => {
    const { out, io } = makeIo(true);
    expect(await runCli([], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("safari-attraction");
    expect(text).toContain("setup [--dry-run] [--no-claude-code] [--no-desktop]");
    expect(text).toContain("doctor");
    expect(text).toContain("--version");
    expect(text).toContain("help");
    expect(text).toContain("MCP 서버");
  });

  test("인자 없음 + 터미널 아님 → serve, 아무것도 찍지 않는다", async () => {
    const { out, err, io } = makeIo(false);
    expect(await runCli([], io)).toBe("serve");
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("--version · -v → 버전 한 줄, 0", async () => {
    for (const flag of ["--version", "-v"]) {
      const { out, io } = makeIo(true);
      expect(await runCli([flag], io)).toBe(0);
      expect(out.join("\n").trim()).toBe("0.1.0");
    }
  });

  test("help · --help → 도움말, 0", async () => {
    for (const flag of ["help", "--help"]) {
      const { out, io } = makeIo(false);
      expect(await runCli([flag], io)).toBe(0);
      expect(out.join("\n")).toContain("setup");
    }
  });

  test("모르는 명령 → 도움말 + 2", async () => {
    const { out, err, io } = makeIo(true);
    expect(await runCli(["bogus"], io)).toBe(2);
    expect(err.join("\n")).toContain("bogus");
    expect(out.join("\n") + err.join("\n")).toContain("setup");
  });

  test("setup 의 모르는 옵션 → 2", async () => {
    const { io } = makeIo(true);
    expect(await runCli(["setup", "--nope"], io)).toBe(2);
  });

  test("doctor: 모두 됨 → 결과를 찍고 0, 시험 탭 · 드라이버를 닫는다", async () => {
    const d = createFakeDriver();
    d.answer = () => "2";
    let closed = 0;
    let ownedClosed = 0;
    const real = d.closeOwned.bind(d);
    d.closeOwned = async () => ((ownedClosed++, real()));
    d.close = async () => void closed++;
    const { out, io } = makeIo(true);
    expect(await runCli(["doctor"], io, { createDriver: () => d })).toBe(0);
    expect(out.join("\n")).toContain("준비 끝");
    expect(ownedClosed).toBe(1);
    expect(closed).toBe(1);
  });

  test("doctor: 빠진 게 있으면 1", async () => {
    const d = createFakeDriver();
    d.answer = () => {
      throw new SafariError("JS_FROM_APPLE_EVENTS_OFF", "x");
    };
    d.close = async () => {};
    const { out, io } = makeIo(true);
    expect(await runCli(["doctor"], io, { createDriver: () => d })).toBe(1);
    expect(out.join("\n")).toContain("✗");
  });
});
