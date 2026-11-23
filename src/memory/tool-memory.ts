import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeMachineState, type ActivityLog } from "./activity.js";
import { findSecret } from "./guard.js";
import { MemoryHome, localDate, nfc } from "./home.js";
import { bytes, cutBytes, formatHits, type MemoryIndex } from "./search.js";
import { appendToSection } from "./sections.js";
import { siteFileName, siteLookupChain } from "./site.js";

// ───────────────────────── 값 ─────────────────────────

/** 기억 · 프로젝트 도구 한 번 출력 상한(UTF-8 바이트). */
export const OUTPUT_MAX_BYTES = 8192;
const TIDY_LOG_BUDGET = 5000; // tidy: 일지 몫(파일 머리 줄 포함)
const TIDY_OLD_TAIL = 1500; // tidy: 오래-기억.md 끝에서 담는 바이트
const ARCHIVE_DIR = "기억/일지/보관";
const OLD_MEMORY = "기억/오래-기억.md";
const ME_FILE = "기억/나.md";
const SITE_DIR = "기억/사이트";
const CONFLICT_SHOW = 3;
const CUT_NOTE = "… 8KB 를 넘는 부분은 줄였어요";
const FORGET_LINE_MAX = 200; // 글자

export type MemoryInput = {
  action: "remember" | "search" | "read" | "forget" | "tidy" | "tidy_save" | "pause";
  text?: string;
  about?: string;
  query?: string;
  path?: string;
  on?: boolean;
};

export type ToolResult = { text: string; isError?: boolean };

export type MemoryCtx = {
  home: MemoryHome;
  index: MemoryIndex;
  activity: ActivityLog;
  now: () => Date;
};

type Outcome = { body: string; isError?: boolean; files?: string[] };

const fail = (body: string, files?: string[]): Outcome => ({ body, isError: true, files });

const lenChars = (s: string) => [...s].length;

function clipChars(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

// ───────────────────────── 결과 꾸미기(project 도구도 같이 쓴다) ─────────────────────────

/** iCloud 충돌본(「이름 2.md」) 중 이번 호출이 읽거나 쓴 파일에 딸린 것. 알아낼 수 없으면 빈 목록. */
async function conflictsOf(home: MemoryHome, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const touched = new Set(files.map(nfc));
  try {
    return (await home.conflicts()).filter((c) => touched.has(c) || touched.has(c.replace(/ \d+\.md$/, ".md")));
  } catch {
    return [];
  }
}

/**
 * 도구 결과를 마무리한다: 열린 프로젝트가 있으면 첫 줄 「열린 프로젝트: 이름」, 이번 호출이 다룬 파일에 충돌본이 있으면 끝 줄
 * 「충돌본이 있어요: … — 합쳐 주세요」, 전체는 8,192 바이트 이하(넘으면 본문 끝을 줄인다).
 */
export async function composeResult(
  ctx: { home: MemoryHome; activity: ActivityLog },
  body: string,
  opts: { isError?: boolean; files?: string[] } = {},
): Promise<ToolResult> {
  const head = ctx.activity.state.openProject ? `열린 프로젝트: ${ctx.activity.state.openProject}\n` : "";
  const found = await conflictsOf(ctx.home, opts.files ?? []);
  let tail = "";
  if (found.length > 0) {
    const shown = found.slice(0, CONFLICT_SHOW).join(", ") + (found.length > CONFLICT_SHOW ? ` 외 ${found.length - CONFLICT_SHOW}개` : "");
    tail = `\n충돌본이 있어요: ${shown} — 합쳐 주세요`;
  }
  const room = OUTPUT_MAX_BYTES - bytes(head) - bytes(tail);
  let text = body;
  if (bytes(text) > room) {
    const note = `\n${CUT_NOTE}`;
    text = cutBytes(text, Math.max(0, room - bytes(note))) + note;
  }
  const out = head + text + tail;
  return opts.isError ? { text: out, isError: true } : { text: out };
}

// ───────────────────────── 파일 보기 · 쓰기 도우미 ─────────────────────────

async function kindOf(home: MemoryHome, rel: string): Promise<"file" | "dir" | "none"> {
  try {
    const st = await stat(home.path(rel));
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "none";
  } catch {
    return "none";
  }
}

/** 쓰기 action 을 시작하기 전에 폴더를 쓸 수 있는지 본다. 못 쓰면 오류 결과, 쓸 수 있으면 null. */
async function writeGate(home: MemoryHome): Promise<Outcome | null> {
  const w = await home.writable();
  return w.ok ? null : fail(`기억 폴더에 쓸 수 없어요: ${home.dir} — ${w.reason}`);
}

/** 줄 끝 개행을 한 줄로: 줄 바꿈은 공백 하나로, 앞뒤 공백은 뗀다. */
const oneLine = (s: string) => nfc(s).replace(/\s*[\r\n]+\s*/g, " ").trim();

/** 파일 끝에 줄 하나를 덧붙인 글(없던 파일이면 그 줄만). 끝 줄 바꿈은 하나. */
const withAppendedLine = (old: string | null, line: string) =>
  old === null || old === "" ? `${line}\n` : `${old.replace(/\n*$/, "")}\n${line}\n`;

function siteHost(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

// ───────────────────────── remember ─────────────────────────

async function remember(ctx: MemoryCtx, input: MemoryInput): Promise<Outcome> {
  const { home, activity } = ctx;
  const text = oneLine(input.text ?? "");
  if (!text) return fail("기억할 내용(text)을 알려 주세요.");
  const secret = findSecret(text);
  if (secret !== null) {
    return fail(`${secret} 같은 민감한 값이 들어 있어서 저장하지 않았어요. 그 값을 빼고 다시 말해 주세요.`);
  }

  const about = nfc((input.about ?? "").trim());
  let rel: string;
  let siteKey: string | null = null;
  let project: string | null = null;
  const siteMatch = /^사이트\s*[:：]\s*(.*)$/.exec(about);
  if (about === "" || about === "나") {
    rel = ME_FILE;
  } else if (siteMatch) {
    const host = siteHost(siteMatch[1]!);
    if (host === null) return fail(`사이트 주소를 알아볼 수 없어요: ${siteMatch[1]!.trim() || "(비어 있음)"} — 예: 사이트:coupang.com`);
    const name = siteFileName(host);
    siteKey = name.replace(/\.md$/, "");
    rel = `${SITE_DIR}/${name}`;
  } else if (about === "프로젝트") {
    project = activity.state.openProject;
    if (!project) return fail("열린 프로젝트가 없어요. project 도구로 프로젝트를 먼저 열어 주세요.");
    rel = `프로젝트/${project}/프로젝트.md`;
  } else {
    return fail(`about 은 "나" · "사이트:<주소>" · "프로젝트" 중 하나로 알려 주세요: ${about}`);
  }

  const blocked = await writeGate(home);
  if (blocked) return blocked;

  const line = `- ${localDate(ctx.now())} ${text}`;
  const old = await home.read(rel);
  if (project !== null) {
    if (old === null) return fail(`프로젝트 문서를 찾을 수 없어요: ${rel}`);
    await home.writeShared(rel, appendToSection(old, "메모", line));
  } else {
    await home.writeShared(rel, withAppendedLine(old, line));
  }

  if (siteKey !== null) {
    // 방금 쓴 메모가 다음 방문 때 붙도록, 이 메모를 찾아 쓸 수 있는 도메인을 「이미 봤음」에서 뺀다.
    const seen = activity.state.seenDomains;
    seen.delete(siteKey);
    const name = `${siteKey}.md`;
    for (const k of [...seen]) if (siteLookupChain(k).includes(name)) seen.delete(k);
  }
  return { body: `기억했어요: ${rel}`, files: [rel] };
}

// ───────────────────────── search ─────────────────────────

async function search(ctx: MemoryCtx, input: MemoryInput): Promise<Outcome> {
  const query = (input.query ?? "").trim();
  if (!query) return fail("찾을 말(query)을 알려 주세요.");
  const hits = await ctx.index.search(query, { project: ctx.activity.state.openProject ?? undefined });
  return { body: formatHits(hits), files: hits.map((h) => h.file) };
}

// ───────────────────────── read ─────────────────────────

/** 집 폴더 기준 경로로 다듬는다: 앞뒤 공백 · 집 폴더 절대 경로 접두 · 앞뒤 `/` 를 뗀다. */
function relPathOf(home: MemoryHome, raw: string): string {
  let p = nfc(raw.trim());
  const prefix = nfc(home.dir) + "/";
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  else if (p === nfc(home.dir)) p = "";
  return p.replace(/^\/+|\/+$/g, "");
}

async function listFolder(home: MemoryHome, rel: string, note: string): Promise<Outcome> {
  const names = (await home.list(rel)).filter((n) => !n.startsWith("."));
  const lines: string[] = [];
  for (const n of names) {
    const child = rel ? `${rel}/${n}` : n;
    lines.push(`- ${n}${(await kindOf(home, child)) === "dir" ? "/" : ""}`);
  }
  const title = `${note}폴더: ${rel ? `${rel}/` : "(기억 폴더 맨 위)"}`;
  return { body: lines.length > 0 ? `${title}\n${lines.join("\n")}` : `${title}\n(비어 있어요)` };
}

async function read(ctx: MemoryCtx, input: MemoryInput): Promise<Outcome> {
  const { home } = ctx;
  let rel: string;
  try {
    rel = relPathOf(home, input.path ?? "");
    if (rel) home.path(rel); // 집 폴더 밖 경로는 여기서 거절된다
  } catch (e) {
    return fail((e as Error).message);
  }
  if (rel === "") return listFolder(home, "", "");
  const kind = await kindOf(home, rel);
  if (kind === "file") {
    const text = (await home.read(rel)) ?? "";
    return { body: `파일: ${rel}\n${text === "" ? "(비어 있어요)" : text}`, files: [rel] };
  }
  if (kind === "dir") return listFolder(home, rel, "");
  // 없는 경로: 가장 가까운 있는 폴더(위로 거슬러 올라간다), 없으면 집 폴더 맨 위.
  let parent = rel;
  for (;;) {
    parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    if (parent === "" || (await kindOf(home, parent)) === "dir") break;
  }
  return listFolder(home, parent, `파일이 아니거나 없어요: ${rel} — 가까운 `);
}

// ───────────────────────── forget ─────────────────────────

async function forgetFiles(home: MemoryHome): Promise<string[]> {
  const sites = (await home.list(SITE_DIR)).filter((n) => n.endsWith(".md") && !n.startsWith(".")).map((n) => `${SITE_DIR}/${n}`);
  return [ME_FILE, ...sites];
}

async function forget(ctx: MemoryCtx, input: MemoryInput): Promise<Outcome> {
  const { home } = ctx;
  const text = nfc((input.text ?? "").trim());
  if (lenChars(text) < 2) return fail("지울 내용(text)을 두 글자 이상 알려 주세요.");
  const blocked = await writeGate(home);
  if (blocked) return blocked;

  const found: { rel: string; no: number; line: string; lines: string[]; raw: string }[] = [];
  for (const rel of await forgetFiles(home)) {
    const raw = await home.read(rel);
    if (raw === null) continue;
    const lines = raw.split("\n");
    lines.forEach((line, i) => {
      if (nfc(line).includes(text)) found.push({ rel, no: i + 1, line, lines, raw });
    });
  }
  if (found.length === 0) return { body: `지울 줄을 찾지 못했어요: "${text}" (기억/나.md · 기억/사이트/ 안에서 찾았어요)` };
  if (found.length > 1) {
    const list = found.map((f) => `- ${f.rel}:${f.no}  ${clipChars(f.line.trim(), FORGET_LINE_MAX)}`).join("\n");
    return {
      body: `${found.length}줄이 걸려서 아무것도 지우지 않았어요. 지울 줄만 걸리도록 text 를 더 길게 알려 주세요:\n${list}`,
      files: [...new Set(found.map((f) => f.rel))],
    };
  }
  const hit = found[0]!;
  const rest = hit.lines.filter((_, i) => i !== hit.no - 1);
  await home.writeShared(hit.rel, rest.join("\n"));
  return { body: `지웠어요: ${hit.rel}:${hit.no}\n${hit.line.trim()}`, files: [hit.rel] };
}

// ───────────────────────── tidy ─────────────────────────

const LOG_NAME = /^(\d{4}-\d{2}-\d{2})-.+\.md$/;

/** 글의 끝에서 max 바이트(글자 경계를 지켜서). 잘렸으면 truncated. */
function tailBytes(s: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, truncated: false };
  let start = buf.length - max;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++; // 글자 한가운데면 다음 글자부터
  return { text: buf.subarray(start).toString("utf8"), truncated: true };
}

/** 혼자 너무 큰 하루: 앞 · 뒤 줄을 번갈아 남기고 가운데를 「… N줄 생략 …」으로 줄여 budget 바이트 안으로. */
function squeezeMiddle(content: string, budget: number): string {
  const lines = content.replace(/\n+$/, "").split("\n");
  const markerRoom = bytes("… 99999줄 생략 …\n");
  let head = 0;
  let tail = 0;
  let used = markerRoom;
  for (;;) {
    let progressed = false;
    if (head + tail < lines.length) {
      const n = bytes(lines[head]!) + 1;
      if (used + n <= budget) {
        used += n;
        head++;
        progressed = true;
      }
    }
    if (head + tail < lines.length) {
      const n = bytes(lines[lines.length - 1 - tail]!) + 1;
      if (used + n <= budget) {
        used += n;
        tail++;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  if (head + tail === 0) return cutBytes(lines[0]!, Math.max(0, budget - bytes("\n… 이하 생략 …"))) + "\n… 이하 생략 …";
  const omitted = lines.length - head - tail;
  const marker = omitted > 0 ? [`… ${omitted}줄 생략 …`] : [];
  return [...lines.slice(0, head), ...marker, ...lines.slice(lines.length - tail)].join("\n");
}

async function tidy(ctx: MemoryCtx): Promise<Outcome> {
  const { home, activity } = ctx;
  const today = localDate(ctx.now());
  const names = (await home.list("기억/일지")).filter((n) => {
    const m = LOG_NAME.exec(n);
    return m !== null && m[1]! < today;
  });
  const logs: { name: string; text: string }[] = [];
  for (const name of names) {
    const text = await home.read(`기억/일지/${name}`);
    if (text !== null) logs.push({ name, text });
  }
  if (logs.length === 0) {
    activity.state.pendingTidy = null;
    return { body: `정리할 일지가 없어요. (오늘(${today}) 이전 날짜의 일지가 없어요.)` };
  }

  // 일지 몫 안에서 오래된 것부터 파일 통째로(머리 줄 포함). 첫 파일 혼자 넘으면 가운데를 줄여서라도 담는다.
  const blocks: string[] = [];
  const taken: string[] = [];
  let used = 0;
  let squeezed = 0;
  for (const [i, log] of logs.entries()) {
    const headLine = `### ${log.name}\n`;
    const whole = `${headLine}${log.text.replace(/\n*$/, "")}\n`;
    if (used + bytes(whole) <= TIDY_LOG_BUDGET) {
      blocks.push(whole);
      used += bytes(whole);
      taken.push(log.name);
      continue;
    }
    if (i === 0) {
      const body = squeezeMiddle(log.text, TIDY_LOG_BUDGET - bytes(headLine) - 1);
      const block = `${headLine}${body}\n`;
      blocks.push(block);
      used += bytes(block);
      taken.push(log.name);
      squeezed++;
    }
    break;
  }
  const rest = logs.filter((l) => !taken.includes(l.name));
  const restDays = new Set(rest.map((l) => LOG_NAME.exec(l.name)![1]!)).size;

  const old = await home.read(OLD_MEMORY);
  let oldPart: string;
  if (old === null || old.trim() === "") {
    oldPart = "## 오래-기억.md\n(아직 없어요)\n";
  } else {
    const t = tailBytes(old.replace(/\n*$/, "\n"), TIDY_OLD_TAIL);
    oldPart = `## 오래-기억.md (${t.truncated ? `끝 ${TIDY_OLD_TAIL.toLocaleString("en-US")}바이트만` : "전체"})\n${t.truncated ? "…" : ""}${t.text}`;
  }

  const lines = [
    `기억 정리 — 오늘(${today}) 이전 일지 ${logs.length}개 중 ${taken.length}개를 오래된 순으로 담았어요.${squeezed > 0 ? " (너무 큰 하루는 가운데를 줄였어요.)" : ""}`,
    "",
    ...blocks,
    oldPart,
    `위 일지를 짧게 요약해서 memory 도구 action="tidy_save", text="요약" 으로 보내 주세요. 오래 남길 사실 · 취향 · 자주 한 일만 날짜별로 적으면 돼요. 저장하면 담은 일지 ${taken.length}개는 기억/일지/보관/ 으로 옮겨져요(찾기로는 계속 찾을 수 있어요).`,
  ];
  if (restDays > 0) lines.push(`남은 날 ${restDays}일 — 한 번 더 tidy`);
  activity.state.pendingTidy = { files: taken.map((n) => `기억/일지/${n}`), at: ctx.now().getTime() };
  return { body: lines.join("\n"), files: [OLD_MEMORY] };
}

// ───────────────────────── tidy_save ─────────────────────────

/** 보관 폴더에서 아직 안 쓰는 이름(같은 이름이 이미 있으면 -2, -3 …). */
async function freeArchiveName(home: MemoryHome, name: string): Promise<string> {
  const base = name.replace(/\.md$/, "");
  let candidate = name;
  for (let n = 2; (await kindOf(home, `${ARCHIVE_DIR}/${candidate}`)) !== "none"; n++) candidate = `${base}-${n}.md`;
  return candidate;
}

async function tidySave(ctx: MemoryCtx, input: MemoryInput): Promise<Outcome> {
  const { home, activity } = ctx;
  const pending = activity.state.pendingTidy;
  if (!pending) return fail("먼저 tidy 를 불러 주세요. (정리할 일지를 받은 지 30분이 지났거나 tidy 를 아직 안 불렀어요.)");
  const summary = (input.text ?? "").replace(/\s+$/, "").replace(/^\n+/, "");
  if (!summary.trim()) return fail("정리한 요약(text)을 알려 주세요.");
  const secret = findSecret(summary);
  if (secret !== null) return fail(`${secret} 같은 민감한 값이 들어 있어서 저장하지 않았어요(일지도 그대로 뒀어요). 그 값을 빼고 다시 보내 주세요.`);
  const blocked = await writeGate(home);
  if (blocked) return blocked;

  const now = ctx.now();
  const old = await home.read(OLD_MEMORY);
  const section = `## ${localDate(now)} 정리\n${summary}\n`;
  await home.writeShared(OLD_MEMORY, old === null || old.trim() === "" ? section : `${old.replace(/\n*$/, "")}\n\n${section}`);

  let moved = 0;
  for (const rel of pending.files) {
    if ((await kindOf(home, rel)) !== "file") continue; // 그사이 사라진 파일은 건너뛴다
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const to = join(home.path(ARCHIVE_DIR), await freeArchiveName(home, name));
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(home.path(rel), to);
      moved++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  activity.state.pendingTidy = null;
  await writeMachineState(home, { lastTidy: now.toISOString() });
  return { body: `정리했어요: ${OLD_MEMORY} 에 요약을 더하고 일지 ${moved}개를 기억/일지/보관/ 으로 옮겼어요.`, files: [OLD_MEMORY] };
}

// ───────────────────────── pause ─────────────────────────

function pause(ctx: MemoryCtx, input: MemoryInput): Outcome {
  if (typeof input.on !== "boolean") return fail("on 에 true(기록 멈춤) 또는 false(다시 기록) 를 알려 주세요.");
  ctx.activity.state.paused = input.on;
  return { body: input.on ? "이번 대화 동안 하루 기록을 멈췄어요. (기억 폴더에 아무것도 안 남겨요)" : "하루 기록을 다시 시작했어요." };
}

// ───────────────────────── 진입점 ─────────────────────────

/**
 * memory 도구 한 번. MCP 와 떨어져 있어 그대로 시험할 수 있다.
 * 결과는 항상 8,192 바이트 이하, 열린 프로젝트가 있으면 첫 줄에 이름, 다룬 파일에 충돌본이 있으면 끝 줄에 알림.
 */
export async function runMemoryTool(ctx: MemoryCtx, input: MemoryInput): Promise<ToolResult> {
  ctx.activity.touch();
  let out: Outcome;
  try {
    switch (input.action) {
      case "remember":
        out = await remember(ctx, input);
        break;
      case "search":
        out = await search(ctx, input);
        break;
      case "read":
        out = await read(ctx, input);
        break;
      case "forget":
        out = await forget(ctx, input);
        break;
      case "tidy":
        out = await tidy(ctx);
        break;
      case "tidy_save":
        out = await tidySave(ctx, input);
        break;
      case "pause":
        out = pause(ctx, input);
        break;
      default:
        out = fail(`알 수 없는 action 이에요: ${String((input as { action: unknown }).action)}`);
    }
  } catch (e) {
    out = fail(`기억 도구가 실패했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
  return composeResult(ctx, out.body, { isError: out.isError, files: out.files });
}
