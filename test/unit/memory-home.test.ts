import { chmod, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MemoryHome,
  localDate,
  localTime,
  machineName,
  nfc,
  readMachineName,
  resolveHome,
  sanitizeMachineName,
} from "../../src/memory/home.js";
import { makeTempHome, type TempHome } from "../helpers/memory-home.js";

describe("시험 환경 보호", () => {
  test("setupFiles 가 SAFARI_ATTRACTION_HOME 을 임시 폴더로 돌려 둔다", () => {
    const v = process.env.SAFARI_ATTRACTION_HOME ?? "";
    expect(v.startsWith(tmpdir())).toBe(true);
    expect(v).not.toContain("CloudDocs");
    expect(resolveHome()).toEqual({ dir: v, kind: "env" });
  });
});

describe("resolveHome", () => {
  const HOME = "/Users/x";
  const ICLOUD = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`;

  test("환경 변수가 있으면 그곳(kind env)", () => {
    const probe = () => "exists" as const;
    expect(resolveHome({ SAFARI_ATTRACTION_HOME: "/tmp/h", HOME }, probe)).toEqual({ dir: "/tmp/h", kind: "env" });
  });

  test("iCloud Drive 폴더가 있으면 그 안의 사파리-어트랙션(kind icloud)", () => {
    const seen: string[] = [];
    const r = resolveHome({ HOME }, (p) => {
      seen.push(p);
      return "exists";
    });
    expect(r).toEqual({ dir: `${ICLOUD}/사파리-어트랙션`, kind: "icloud" });
    expect(seen).toEqual([ICLOUD]);
  });

  test("iCloud Drive 폴더가 없으면(missing) Application Support(kind local)", () => {
    const r = resolveHome({ HOME }, () => "missing");
    expect(r).toEqual({ dir: `${HOME}/Library/Application Support/safari-attraction`, kind: "local" });
  });

  test("권한 오류 등(error)이면 몰래 옮기지 않고 iCloud 를 그대로 돌려준다", () => {
    const r = resolveHome({ HOME }, () => "error");
    expect(r).toEqual({ dir: `${ICLOUD}/사파리-어트랙션`, kind: "icloud" });
  });

  test("빈 환경 변수는 없는 것으로 본다", () => {
    expect(resolveHome({ SAFARI_ATTRACTION_HOME: "", HOME }, () => "exists").kind).toBe("icloud");
  });
});

describe("localDate · localTime", () => {
  const saved = process.env.TZ;
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  test("이 맥 시간대 기준 날짜(UTC 15:30 → 서울 다음 날)", () => {
    process.env.TZ = "Asia/Seoul";
    const d = new Date("2026-11-22T15:30:00Z");
    expect(localDate(d)).toBe("2026-11-23");
    expect(localTime(d)).toBe("00:30");
  });

  test("한 자리 월 · 일 · 시 · 분은 0 으로 채운다", () => {
    process.env.TZ = "Asia/Seoul";
    const d = new Date("2026-01-04T00:05:00Z");
    expect(localDate(d)).toBe("2026-01-04");
    expect(localTime(d)).toBe("09:05");
  });
});

describe("machineName", () => {
  test("sanitizeMachineName: 영문 · 숫자 · 한글 · - 만, 나머지는 -, 반복은 하나로, 앞뒤 - 는 뗀다", () => {
    expect(sanitizeMachineName("박정욱의 MacBook Pro")).toBe("박정욱의-MacBook-Pro");
    expect(sanitizeMachineName("  Yuri's  Mac_mini!! ")).toBe("Yuri-s-Mac-mini");
    expect(sanitizeMachineName("a/b\\c:d")).toBe("a-b-c-d");
  });

  test("sanitizeMachineName: NFD 한글은 NFC 로 맞춘다", () => {
    const nfd = "맥북".normalize("NFD");
    expect(nfd).not.toBe("맥북");
    expect(sanitizeMachineName(nfd)).toBe("맥북");
  });

  test("sanitizeMachineName: 40자 상한(자른 뒤 끝의 - 도 뗀다)", () => {
    expect(sanitizeMachineName("가".repeat(100))).toBe("가".repeat(40));
    expect(sanitizeMachineName("a".repeat(39) + " bbbb")).toBe("a".repeat(39));
  });

  test("readMachineName: scutil 결과를 쓰고, 실패하면 hostname, 둘 다 비면 mac", () => {
    expect(readMachineName({ scutil: () => "내 맥 미니\n", hostname: () => "host" })).toBe("내-맥-미니");
    expect(
      readMachineName({
        scutil: () => {
          throw new Error("no scutil");
        },
        hostname: () => "Yuris-MacBook.local",
      }),
    ).toBe("Yuris-MacBook-local");
    expect(readMachineName({ scutil: () => "  ", hostname: () => "h" })).toBe("h");
    expect(readMachineName({ scutil: () => "", hostname: () => "!!!" })).toBe("mac");
  });

  test("machineName: 파일 이름에 쓸 수 있는 값이고 호출마다 같다", () => {
    const a = machineName();
    expect(a).toMatch(/^[A-Za-z0-9가-힣-]{1,40}$/);
    expect(machineName()).toBe(a);
  });
});

describe("nfc", () => {
  test("NFD 를 NFC 로", () => {
    expect(nfc("나".normalize("NFD"))).toBe("나");
  });
});

describe("MemoryHome", () => {
  let t: TempHome;
  let h: MemoryHome;
  beforeEach(async () => {
    t = await makeTempHome();
    h = new MemoryHome(t.dir);
  });
  afterEach(async () => {
    await chmod(t.dir, 0o755).catch(() => {});
    await t.remove();
  });

  test("path: 집 폴더 안 경로를 이어 붙인다", () => {
    expect(h.path("기억", "나.md")).toBe(join(t.dir, "기억", "나.md"));
    expect(h.path()).toBe(t.dir);
  });

  test("path: .. · 절대 경로는 거절한다", () => {
    expect(() => h.path("..", "x")).toThrow();
    expect(() => h.path("기억/../../x")).toThrow();
    expect(() => h.path("기억\\..\\x")).toThrow();
    expect(() => h.path("/etc/passwd")).toThrow();
    expect(() => h.path("기억", "/etc/passwd")).toThrow();
  });

  test("모든 메서드가 집 폴더 밖 경로를 거절한다", async () => {
    await expect(h.append("../x.md", "a")).rejects.toThrow();
    await expect(h.writeShared("/tmp/x.md", "a")).rejects.toThrow();
    await expect(h.read("../x.md")).rejects.toThrow();
    await expect(h.list("..")).rejects.toThrow();
    await expect(h.walk("../..")).rejects.toThrow();
  });

  test("ensure: 폴더를 만든다(이미 있어도 된다)", async () => {
    const home = new MemoryHome(join(t.dir, "새", "집"));
    await home.ensure();
    await home.ensure();
    expect((await stat(home.dir)).isDirectory()).toBe(true);
  });

  test("append: 폴더가 없으면 만들고, 두 번 덧붙이면 두 줄", async () => {
    await h.append("기억/일지/2026-11-23.md", "첫 줄\n");
    await h.append("기억/일지/2026-11-23.md", "둘째 줄\n");
    expect(await h.read("기억/일지/2026-11-23.md")).toBe("첫 줄\n둘째 줄\n");
  });

  test("writeShared: 내용이 맞고 임시 파일이 안 남는다, 덮어쓰기도 된다", async () => {
    await h.writeShared("기억/나.md", "하나");
    await h.writeShared("기억/나.md", "둘");
    expect(await h.read("기억/나.md")).toBe("둘");
    expect(await readdir(join(t.dir, "기억"))).toEqual(["나.md"]);
  });

  test("writeShared: 쓰다 실패하면 임시 파일도 원래 파일도 그대로", async () => {
    await h.writeShared("기억/나.md", "원래");
    // 대상 자리에 폴더가 있으면 이름 바꾸기가 실패한다.
    await mkdir(join(t.dir, "기억", "폴더.md"));
    await expect(h.writeShared("기억/폴더.md", "x")).rejects.toThrow();
    expect((await readdir(join(t.dir, "기억"))).sort()).toEqual(["나.md", "폴더.md"]);
    expect(await h.read("기억/나.md")).toBe("원래");
  });

  test("read: 없는 파일은 null", async () => {
    expect(await h.read("없는.md")).toBeNull();
  });

  test("list: 파일 · 폴더 이름을 NFC 로 정렬해 돌려준다, 없는 폴더는 []", async () => {
    await mkdir(join(t.dir, "사이트"));
    await writeFile(join(t.dir, "사이트", "나.md".normalize("NFD")), "x");
    await writeFile(join(t.dir, "사이트", "가.md"), "x");
    await mkdir(join(t.dir, "사이트", "하위"));
    const names = await h.list("사이트");
    expect(names).toEqual(["가.md", "나.md", "하위"]);
    expect(names.every((n) => n === n.normalize("NFC"))).toBe(true);
    expect(await h.list("없는폴더")).toEqual([]);
  });

  test("walk: 하위 폴더까지 파일만, 상대 경로(NFC) · mtime · 크기, 없는 폴더는 []", async () => {
    await mkdir(join(t.dir, "기억", "일지", "보관"), { recursive: true });
    await writeFile(join(t.dir, "기억", "일지", "a.md"), "abc");
    await writeFile(join(t.dir, "기억", "일지", "보관", "나.md".normalize("NFD")), "12345");
    const when = new Date("2026-01-01T00:00:00Z");
    await utimes(join(t.dir, "기억", "일지", "a.md"), when, when);
    const out = await h.walk("기억");
    expect(out.map((e) => e.rel)).toEqual(["기억/일지/a.md", "기억/일지/보관/나.md"]);
    expect(out[0]!.size).toBe(3);
    expect(out[0]!.mtimeMs).toBe(when.getTime());
    expect(out[1]!.size).toBe(5);
    expect(await h.walk("기억/일지/보관")).toHaveLength(1);
    expect(await h.walk("없는")).toEqual([]);
  });

  test("walk(\"\"): 집 폴더 전체", async () => {
    await h.append("a.md", "x");
    await h.append("b/c.md", "x");
    expect((await h.walk("")).map((e) => e.rel)).toEqual(["a.md", "b/c.md"]);
  });

  test("conflicts: 「나 2.md」 꼴 충돌본을 찾는다(원본이 있을 때만, 하위 폴더 포함)", async () => {
    await h.writeShared("기억/나.md", "원본");
    await h.writeShared("기억/나 2.md", "충돌본");
    await h.writeShared("기억/나 3.md", "충돌본");
    await h.writeShared("사이트/coupang.com.md", "원본");
    await h.writeShared("사이트/coupang.com 2.md", "충돌본");
    await h.writeShared("기억/혼자 2.md", "원본 없음");
    await h.writeShared("기억/메모.md", "그냥");
    expect((await h.conflicts()).sort()).toEqual(["기억/나 2.md", "기억/나 3.md", "사이트/coupang.com 2.md"]);
  });

  test("conflicts: 충돌본이 없으면 []", async () => {
    await h.writeShared("기억/나.md", "x");
    expect(await h.conflicts()).toEqual([]);
  });

  test("writable: 쓸 수 있는 폴더(없으면 만들어서)는 ok, 임시 확인 파일은 안 남는다", async () => {
    const home = new MemoryHome(join(t.dir, "새집"));
    expect(await home.writable()).toEqual({ ok: true });
    expect(await readdir(home.dir)).toEqual([]);
  });

  test("writable: 쓰기 막힌 폴더(0500)에서는 ok:false + 이유", async () => {
    if (process.getuid?.() === 0) return; // root 는 권한을 무시한다.
    await chmod(t.dir, 0o500);
    const r = await h.writable();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/EACCES|권한/);
  });

  test("writable: 폴더 자리에 파일이 있으면 ok:false", async () => {
    await writeFile(join(t.dir, "파일"), "x");
    const r = await new MemoryHome(join(t.dir, "파일")).writable();
    expect(r.ok).toBe(false);
  });
});

describe("MemoryHome.exclusive — 같은 프로세스 안 차례 줄", () => {
  test("들어온 순서대로 하나씩 돈다(앞 것이 끝나야 다음이 시작)", async () => {
    const home = new MemoryHome(tmpdir());
    const events: string[] = [];
    const job = (name: string, ms: number) =>
      home.exclusive(async () => {
        events.push(`${name} 시작`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`${name} 끝`);
        return name;
      });
    const got = await Promise.all([job("a", 30), job("b", 1), job("c", 10)]);
    expect(got).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a 시작", "a 끝", "b 시작", "b 끝", "c 시작", "c 끝"]);
  });

  test("실패한 일은 호출자에게 던지되 다음 일을 막지 않는다", async () => {
    const home = new MemoryHome(tmpdir());
    const bad = home.exclusive(async () => {
      throw new Error("앗");
    });
    const next = home.exclusive(async () => "다음");
    await expect(bad).rejects.toThrow("앗");
    await expect(next).resolves.toBe("다음");
    await expect(home.exclusive(async () => "또")).resolves.toBe("또");
  });

  test("동기로 던지는 함수도 줄을 깨지 않는다", async () => {
    const home = new MemoryHome(tmpdir());
    await expect(
      home.exclusive((() => {
        throw new Error("동기");
      }) as () => Promise<never>),
    ).rejects.toThrow("동기");
    await expect(home.exclusive(async () => 1)).resolves.toBe(1);
  });
});
