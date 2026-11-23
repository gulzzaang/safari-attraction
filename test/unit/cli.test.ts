import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { VERSION } from "../../src/version.js";
import { createFakeDriver } from "../helpers/fake-driver.js";
import { SafariError } from "../../src/driver/types.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeIo(stdinIsTTY: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s), stdinIsTTY } };
}

describe("명령줄(runCli)", () => {
  test("VERSION 은 x.y.z 모양(자리마다 같은지는 version-sync 시험이 본다)", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
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
      expect(out.join("\n").trim()).toBe(VERSION);
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

  test("doctor: 기억 줄이 붙는다(사파리 점검 뒤), 폴더 위치는 환경 변수를 따른다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "safari-attraction-cli-"));
    try {
      const d = createFakeDriver();
      d.answer = () => "2";
      d.close = async () => {};
      const { out, io } = makeIo(true);
      expect(await runCli(["doctor"], io, { createDriver: () => d, env: { SAFARI_ATTRACTION_HOME: dir } })).toBe(0);
      const t = out.join("\n");
      expect(t).toContain(`✓ 기억 폴더: ${dir} · 환경 변수`);
      expect(t).toContain("마지막 정리: 아직 없음");
      expect(t.indexOf("준비 끝")).toBeLessThan(t.indexOf("기억 폴더"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctor: 기억 폴더를 못 써도 종료 코드는 사파리 점검만 따른다(0), 줄에는 ✗ 로 나온다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "safari-attraction-cli-"));
    try {
      await writeFile(join(dir, "막음"), "x", "utf8");
      const d = createFakeDriver();
      d.answer = () => "2";
      d.close = async () => {};
      const { out, io } = makeIo(true);
      const env = { SAFARI_ATTRACTION_HOME: join(dir, "막음", "하위") };
      expect(await runCli(["doctor"], io, { createDriver: () => d, env })).toBe(0);
      expect(out.join("\n")).toContain("✗ 기억 폴더:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
