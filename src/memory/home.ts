import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** 한글 이름은 NFC 로 맞춘 뒤 비교 · 저장한다(Finder 로 바꾼 이름은 NFD 일 수 있다). */
export function nfc(s: string): string {
  return s.normalize("NFC");
}

// ───────────────────────── 기억 폴더 위치 ─────────────────────────

export type HomeKind = "env" | "icloud" | "local";
export type Probe = (p: string) => "exists" | "missing" | "error";

/** 실제 파일 시스템으로 보는 probe: 없음(ENOENT)만 missing, 그 밖의 오류(권한 등)는 error. */
const fsProbe: Probe = (p) => {
  try {
    statSync(p);
    return "exists";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
  }
};

/**
 * 기억 폴더 위치.
 * 1) SAFARI_ATTRACTION_HOME 2) iCloud Drive 안 `사파리-어트랙션/` 3) iCloud Drive 폴더 자체가 없을 때만(ENOENT)
 * `~/Library/Application Support/safari-attraction/`.
 * 권한 오류 등(error)이면 iCloud 를 그대로 돌려준다 — 몰래 옮기지 않는다(쓸 수 있는지는 writable() 이 알린다).
 */
export function resolveHome(
  env: NodeJS.ProcessEnv = process.env,
  probe: Probe = fsProbe,
): { dir: string; kind: HomeKind } {
  const fromEnv = env.SAFARI_ATTRACTION_HOME;
  if (fromEnv) return { dir: resolve(fromEnv), kind: "env" };
  const home = env.HOME || homedir();
  const cloudDocs = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  if (probe(cloudDocs) === "missing") {
    return { dir: join(home, "Library", "Application Support", "safari-attraction"), kind: "local" };
  }
  return { dir: join(cloudDocs, nfc("사파리-어트랙션")), kind: "icloud" };
}

// ───────────────────────── 날짜 · 시각(이 맥 시간대) ─────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD`, 이 맥 시간대 기준(toISOString 쓰지 않는다). */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `HH:MM`, 이 맥 시간대 기준. */
export function localTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ───────────────────────── 맥 이름 ─────────────────────────

const MACHINE_NAME_MAX = 40;

/** 파일 이름에 쓸 수 있게: NFC, 영문 · 숫자 · 한글 · - 만 남기고 나머지는 -, 반복은 하나로, 앞뒤 - 는 떼고 40자 상한. */
export function sanitizeMachineName(raw: string): string {
  const s = nfc(raw)
    .replace(/[^A-Za-z0-9가-힣-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return [...s].slice(0, MACHINE_NAME_MAX).join("").replace(/-+$/g, "");
}

function runScutil(): string {
  return execFileSync("scutil", ["--get", "ComputerName"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** `scutil --get ComputerName`(시험에서는 바꿔 끼운다) → 실패하거나 비면 os.hostname() → 그래도 비면 "mac". */
export function readMachineName(
  deps: { scutil: () => string; hostname: () => string } = { scutil: runScutil, hostname },
): string {
  let name = "";
  try {
    name = sanitizeMachineName(deps.scutil());
  } catch {
    // 아래 hostname 으로.
  }
  if (!name) {
    try {
      name = sanitizeMachineName(deps.hostname());
    } catch {
      // 아래 기본값으로.
    }
  }
  return name || "mac";
}

let cachedMachineName: string | undefined;

/** 이 맥의 이름(파일 이름용). 프로세스 안에서 한 번만 계산한다. */
export function machineName(): string {
  cachedMachineName ??= readMachineName();
  return cachedMachineName;
}

// ───────────────────────── 기억 폴더 ─────────────────────────

const REASONS: Record<string, string> = {
  EACCES: "권한이 없어요",
  EPERM: "권한이 없어요",
  EROFS: "읽기 전용이에요",
  ENOSPC: "저장 공간이 없어요",
  ENOENT: "폴더를 만들 수 없어요",
  ENOTDIR: "폴더 자리에 파일이 있어요",
  EEXIST: "폴더 자리에 파일이 있어요",
};

function reasonOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code) return `${REASONS[code] ?? "쓰기에 실패했어요"} (${code})`;
  return e instanceof Error ? e.message : String(e);
}

const isMissing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * 기억 폴더 하나. 모든 경로는 이 폴더 밖으로 나가지 못한다(`..` · 절대 경로 거절).
 * 같은 맥에서 여러 서버가 함께 덧붙이는 파일은 append(), 두 맥이 함께 쓰는 파일은 writeShared() 로 쓴다.
 */
export class MemoryHome {
  readonly dir: string;
  /** exclusive() 의 차례 줄. 앞 일이 실패해도 끊기지 않는다. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /**
   * 같은 프로세스 안에서 「읽고 → 고쳐 → 쓰는」 공유 파일 일을 한 줄로 세운다(들어온 순서대로 하나씩).
   * 한 일이 실패해도 던지는 건 그 호출자에게만이고 다음 일은 그대로 돈다. 안에서 다시 exclusive 를 부르면 서로 기다리니 부르지 않는다.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => {});
    return run;
  }

  /** 집 폴더 안 경로. `..` · 절대 경로가 들어 있으면 거절한다. */
  path(...parts: string[]): string {
    const clean = parts.map((p) => {
      const q = nfc(p);
      if (q.includes("\0") || isAbsolute(q) || q.split(/[\\/]/).includes("..")) {
        throw new Error(`기억 폴더 밖의 경로는 쓸 수 없어요: ${p}`);
      }
      return q;
    });
    const full = resolve(this.dir, ...clean);
    if (full !== this.dir && !full.startsWith(this.dir + sep)) {
      throw new Error(`기억 폴더 밖의 경로는 쓸 수 없어요: ${parts.join("/")}`);
    }
    return full;
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** 두 맥이 함께 쓰는 파일: 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꿔 덮어쓴다. */
  async writeShared(rel: string, text: string): Promise<void> {
    const target = this.path(rel);
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, text, "utf8");
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** 맥마다 따로 쓰는 기록: 덧붙이기(여러 서버가 동시에 붙여도 줄이 사라지지 않는다). 폴더가 없으면 만든다. */
  async append(rel: string, text: string): Promise<void> {
    const target = this.path(rel);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, text, "utf8");
  }

  /** 파일 내용. 없으면 null. */
  async read(rel: string): Promise<string | null> {
    try {
      return await readFile(this.path(rel), "utf8");
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  /** relDir 바로 아래 항목(파일 · 폴더) 이름, NFC · 정렬. 폴더가 없으면 []. */
  async list(relDir: string): Promise<string[]> {
    try {
      const names = await readdir(this.path(relDir));
      return names.map(nfc).sort();
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
  }

  /** relDir 아래 모든 파일(폴더는 제외, 하위 폴더까지). rel 은 집 폴더 기준 NFC 경로. 폴더가 없으면 []. */
  async walk(relDir: string): Promise<{ rel: string; mtimeMs: number; size: number }[]> {
    const root = this.path(relDir);
    const out: { rel: string; mtimeMs: number; size: number }[] = [];
    const visit = async (abs: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (e) {
        if (isMissing(e)) return;
        throw e;
      }
      for (const ent of entries) {
        const child = join(abs, ent.name);
        if (ent.isDirectory()) {
          await visit(child);
        } else if (ent.isFile()) {
          try {
            const st = await stat(child);
            out.push({ rel: nfc(child.slice(this.dir.length + 1).split(sep).join("/")), mtimeMs: st.mtimeMs, size: st.size });
          } catch (e) {
            if (!isMissing(e)) throw e; // 읽는 사이 지워진 파일은 건너뛴다.
          }
        }
      }
    };
    await visit(root);
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  /** iCloud 충돌본(「이름 2.md」 꼴, 원본 「이름.md」 가 같은 폴더에 있는 것)의 상대 경로. */
  async conflicts(): Promise<string[]> {
    const all = new Set((await this.walk("")).map((f) => f.rel));
    const found: string[] = [];
    for (const rel of all) {
      const m = /^(.+) \d+\.md$/.exec(rel);
      if (m && all.has(`${m[1]}.md`)) found.push(rel);
    }
    return found.sort();
  }

  /** 폴더를 만들고 확인용 파일을 써 보아 쓸 수 있는지 본다. 이유는 한국어 짧은 글. */
  async writable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const probe = join(this.dir, `.쓰기-확인.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(probe, "", "utf8");
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: reasonOf(e) };
    } finally {
      await unlink(probe).catch(() => {});
    }
  }
}
