// 사람 없음 모드에서는 사파리가 꺼져 있어도 `open -g -a Safari` 를 부르지 않는다. (파일 하나에 child_process 가짜를 건다.)
import { beforeEach, describe, expect, test, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const execFile = ((cmd: string, args: string[], ...rest: unknown[]) => {
    spawned.calls.push([cmd, ...(args ?? [])]);
    const cb = rest[rest.length - 1] as (e: Error | null, v: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: "", stderr: "" });
  }) as unknown as typeof real.execFile;
  return { ...real, execFile };
});

import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import { HostError } from "../../src/driver/jxa-host.js";

beforeEach(() => {
  spawned.calls.length = 0;
});

/** 처음 openTab 은 「꺼져 있음」, 켠 뒤(open 명령이 불린 뒤)에는 정상으로 답하는 호스트. */
const host = (ops: string[]) => ({
  async call(op: string) {
    ops.push(op);
    const launched = spawned.calls.some((c) => c[0] === "open");
    if (!launched) throw new HostError("사파리가 꺼져 있음", undefined, "SAFARI_NOT_RUNNING");
    if (op === "openTab") return { windowId: 5, index: 1, title: "", url: "http://x/", isActive: false, stamped: true };
    return [];
  },
  async close() {},
});

describe("사파리 켜기", () => {
  test("사람 없음: openTab 이 사파리를 켜지 않는다(open 명령 없음)", async () => {
    const ops: string[] = [];
    const d = createJxaDriver({ host: host(ops), unattended: true });
    await expect(d.openTab("http://x/")).rejects.toMatchObject({ code: "SAFARI_NOT_RUNNING" });
    expect(spawned.calls.filter((c) => c[0] === "open")).toEqual([]);
  });
  test("사람 없음이 아니면 지금처럼 open -g -a Safari 로 켜 본다", async () => {
    const ops: string[] = [];
    const d = createJxaDriver({ host: host(ops) });
    await d.openTab("http://x/");
    expect(spawned.calls.filter((c) => c[0] === "open")).toEqual([["open", "-g", "-a", "Safari"]]);
  });
});
