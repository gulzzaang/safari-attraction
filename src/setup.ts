import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ServerCommand {
  command: string;
  args: string[];
}

export interface SetupOptions {
  dryRun: boolean;
  claudeCode: boolean;
  desktop: boolean;
  serverCommand: ServerCommand;
  home: string;
  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
  now: () => Date;
  log: (s: string) => void;
  /** 끝에 붙일 점검 결과 글을 만든다(드라이버를 쓸 수 있을 때만 넘긴다). 미리 보기에서는 부르지 않는다. */
  doctor?: () => Promise<string>;
}

const NAME = "safari-attraction";

/**
 * 등록할 명령. 홈브루 래퍼가 SAFARI_ATTRACTION_BIN 으로 버전이 안 들어간 경로를 넘기면 그것을 쓰고,
 * 아니면 지금 도는 node 와 이 묶음 파일의 절대 경로를 쓴다(Claude 데스크톱은 PATH 가 짧을 수 있어 늘 절대 경로).
 */
export function defaultServerCommand(env: Record<string, string | undefined>, selfPath: string): ServerCommand {
  const bin = env.SAFARI_ATTRACTION_BIN;
  if (bin) return { command: bin, args: [] };
  return { command: process.execPath, args: [selfPath] };
}

const pad = (n: number) => String(n).padStart(2, "0");
function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameCommand = (v: unknown, c: ServerCommand) =>
  isObj(v) && v.command === c.command && Array.isArray(v.args) && v.args.length === c.args.length && v.args.every((a, i) => a === c.args[i]);

/** @returns 실패하면 false */
async function setupClaudeCode(o: SetupOptions): Promise<boolean> {
  let listing: ExecResult | undefined;
  try {
    listing = await o.exec("claude", ["mcp", "list"]);
  } catch {
    listing = undefined;
  }
  if (!listing || listing.code !== 0) {
    o.log("Claude Code(claude 명령)를 찾지 못해 건너뜁니다");
    return true;
  }
  if (listing.stdout.includes(`plugin:${NAME}:`)) {
    o.log("Claude Code: 플러그인으로 이미 연결돼 있어요");
    return true;
  }
  if (new RegExp(`^\\s*${NAME}:`, "m").test(listing.stdout)) {
    o.log("Claude Code: 이미 등록돼 있어요");
    return true;
  }
  const { command, args } = o.serverCommand;
  const addArgs = ["mcp", "add", "--scope", "user", NAME, "--", command, ...args];
  if (o.dryRun) {
    o.log(`Claude Code: 이 명령으로 등록할 거예요 → claude ${addArgs.join(" ")}`);
    return true;
  }
  let res: ExecResult;
  try {
    res = await o.exec("claude", addArgs);
  } catch (e) {
    res = { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
  if (res.code !== 0) {
    o.log(`Claude Code: 등록하지 못했어요 — ${(res.stderr || res.stdout).trim()}`);
    return false;
  }
  o.log("Claude Code: 등록했어요");
  return true;
}

/** @returns 실패하면 false(설정 파일을 못 읽어 건너뛴 것은 실패가 아니다) */
async function setupDesktop(o: SetupOptions): Promise<boolean> {
  const dir = join(o.home, "Library", "Application Support", "Claude");
  const file = join(dir, "claude_desktop_config.json");
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error("not a dir");
  } catch {
    o.log("Claude 데스크톱이 없어 건너뜁니다");
    return true;
  }

  const entry = { command: o.serverCommand.command, args: o.serverCommand.args };
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      o.log(`설정 파일을 읽을 수 없어 데스크톱 연결은 건너뜁니다(파일: ${file})`);
      return true;
    }
  }

  let config: Record<string, unknown> = {};
  if (raw !== undefined && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!isObj(parsed) || (parsed.mcpServers !== undefined && !isObj(parsed.mcpServers))) {
      o.log(`설정 파일을 읽을 수 없어 데스크톱 연결은 건너뜁니다(파일: ${file})`);
      return true;
    }
    config = parsed;
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

  if (sameCommand(servers[NAME], o.serverCommand)) {
    o.log("Claude 데스크톱: 이미 등록돼 있어요");
    return true;
  }

  const next = { ...config, mcpServers: { ...servers, [NAME]: entry } };
  const exists = raw !== undefined;
  const backup = `${file}.bak-${stamp(o.now())}`;
  if (o.dryRun) {
    o.log(
      exists
        ? `Claude 데스크톱: ${file} 에 '${NAME}' 항목만 ${NAME in servers ? "바꾸고" : "더하고"}, 먼저 사본(${backup})을 남길 거예요`
        : `Claude 데스크톱: ${file} 을(를) 새로 만들 거예요`,
    );
    return true;
  }
  try {
    if (exists) await copyFile(file, backup);
    await mkdir(dir, { recursive: true });
    const tmp = join(dirname(file), `.claude_desktop_config.json.tmp-${process.pid}`);
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
    await rename(tmp, file);
  } catch (e) {
    o.log(`Claude 데스크톱: 설정 파일을 쓰지 못했어요 — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  o.log(exists ? `Claude 데스크톱: '${NAME}' 항목을 넣었어요(사본: ${backup})` : `Claude 데스크톱: ${file} 을(를) 만들었어요`);
  return true;
}

/** Claude Code · Claude 데스크톱에 서버를 등록한다. 0 이면 끝(건너뜀 포함), 1 이면 어딘가 실패. */
export async function runSetup(o: SetupOptions): Promise<number> {
  if (o.dryRun) o.log("미리 보기 — 아무것도 바꾸지 않고 할 일만 보여 드려요");
  const { command, args } = o.serverCommand;
  o.log(`등록할 명령: ${[command, ...args].join(" ")}`);

  let ok = true;
  if (o.claudeCode) ok = (await setupClaudeCode(o)) && ok;
  if (o.desktop) ok = (await setupDesktop(o)) && ok;

  o.log("");
  o.log("다음: Claude 데스크톱 · Claude Code 를 다시 켜고, `safari-attraction doctor` 로 준비를 확인하세요");
  if (o.doctor && !o.dryRun) {
    o.log("");
    try {
      o.log(await o.doctor());
    } catch (e) {
      o.log(`점검을 하지 못했어요 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok ? 0 : 1;
}
