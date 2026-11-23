import { mkdir, rename } from "node:fs/promises";
import type { ReplResult } from "../repl/context.js";
import type { ActivityLog, Extra, Touch } from "./activity.js";
import { findSecret } from "./guard.js";
import { MemoryHome, nfc } from "./home.js";
import {
  ARCHIVE_DIR,
  EDITABLE_SECTIONS,
  PROJECT_DIR,
  findName,
  lastRecordDate,
  listProjects,
  projectMdText,
  recentRecords,
  safeDocName,
  safeProjectName,
  siteUrls,
  summaryFirstLine,
  type EditableSection,
} from "./projects.js";
import { composeResult, OUTPUT_MAX_BYTES, type ToolResult } from "./result.js";
import { bytes, cutBytes } from "./search.js";
import { appendToSection, readSection, replaceSection } from "./sections.js";

// ───────────────────────── 값 ─────────────────────────

const UPDATE_MAX_CHARS = 4000; // update · create 요약의 text 상한(글자 = 코드 포인트)
const DOC_MAX_CHARS = 20000; // save_doc 의 text 상한
const OPEN_SITES_MAX = 10;
const RECENT_RECORDS = 5;
const OPEN_SECTION_BYTES = 1000; // open: 절마다 보여 주는 몫(넘으면 줄이고 파일 위치를 알린다). 남는 자리가 모자라면 더 줄인다
const OPEN_DOCS_MAX = 10;
const OPEN_MEMO_LINES = 5; // open: 메모 절에서 보여 주는 마지막 줄 수
const DOC_NAME_CHARS = 50;
const RECORD_LINE_CHARS = 120;
/** open 본문의 상한: 8KB 에서 첫 줄 이름(최대 약 220바이트) · 끝 줄(충돌본 · 정리 안내)이 쓸 몫을 뺀 것. 최근 기록이 맨 끝이라 본문이 넘쳐 잘리면 안 된다. */
const OPEN_BODY_BUDGET = OUTPUT_MAX_BYTES - 1200;
const LIST_SUMMARY_CHARS = 60;
/** 결과 끝에 붙는 글(충돌본 · 정리 안내 · 첫 줄 이름)이 쓸 자리. 사이트 메모 같은 덧붙임은 이 자리를 뺀 안에서만 붙는다. */
const ENVELOPE_RESERVE = 600;
const SITES_ENTRY_TITLE = "프로젝트 사이트 열기";

export type ProjectInput = {
  action: "list" | "create" | "open" | "update" | "save_doc" | "open_sites" | "archive";
  name?: string;
  section?: EditableSection;
  text?: string;
  mode?: "replace" | "append";
  doc?: string;
};

export type { ToolResult };

/** open_sites 한 번을 하루 기록에 남기고 응답에 붙일 글(사이트 메모 · 정리 안내 · 쓰기 실패 안내)을 돌려주는 일(서버가 repl 과 같은 길로 꾸린다). */
export type RecordOpened = (entry: { title: string; touched: Touch[]; ok: boolean; error?: string }) => Promise<(string | Extra)[]>;

export type ProjectCtx = {
  home: MemoryHome;
  activity: ActivityLog;
  now: () => Date;
  /** 사파리 탭 열기(ReplSession.openTabs). 없으면 open_sites 는 오류. */
  openTabs?: (urls: string[]) => Promise<ReplResult>;
  recordOpened?: RecordOpened;
};

type Outcome = { body: string; isError?: boolean; files?: string[] };

const fail = (body: string, files?: string[]): Outcome => ({ body, isError: true, files });

const lenChars = (s: string) => [...s].length;
const fmt = (n: number) => n.toLocaleString("en-US");

function clipChars(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

const mdRel = (dir: string, name: string) => `${dir}/${name}/프로젝트.md`;

/** 쓰기 action 을 시작하기 전에 폴더를 쓸 수 있는지 본다. 못 쓰면 오류 결과, 쓸 수 있으면 null. */
async function writeGate(home: MemoryHome): Promise<Outcome | null> {
  const w = await home.writable();
  return w.ok ? null : fail(`기억 폴더에 쓸 수 없어요: ${home.dir} — ${w.reason}`);
}

/** 글 · 요약 검사(길이 · 민감한 값 · 절 제목 줄). 걸리면 오류 결과. */
function checkText(text: string, max: number, what: string, opts: { headings: boolean }): Outcome | null {
  const n = lenChars(text);
  if (n > max) return fail(`${what}이 너무 길어요(${fmt(max)}자까지): ${fmt(n)}자 — 더 짧게 줄여서 다시 보내 주세요.`);
  const secret = findSecret(text);
  if (secret !== null) return fail(`${secret} 같은 민감한 값이 들어 있어서 저장하지 않았어요. 그 값을 빼고 다시 말해 주세요.`);
  // 프로젝트.md 는 `## 절` 로 나뉘므로 「## 」 로 시작하는 줄은 받지 않는다(절이 깨진다). 「# 」 · 「### 」 는 절을 끊지 않아 괜찮다. 문서(save_doc)는 자유롭게 쓴다.
  if (opts.headings && /^## /m.test(text)) return fail(`${what}에 「## 」 로 시작하는 줄은 쓸 수 없어요(프로젝트 문서의 절이 깨져요). 작은 제목은 「### 」 로 써 주세요.`);
  return null;
}

/** 줄 바꿈을 \n 으로 · 앞의 빈 줄 · 뒤의 공백을 뗀 본문. */
const cleanBody = (s: string) => nfc(s).replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");

/** 이름이 없는 프로젝트를 말할 때 붙이는 「있는 프로젝트」 목록 줄. */
function existingLine(p: { active: string[]; archived: string[] }): string {
  if (p.active.length === 0 && p.archived.length === 0) return "만든 프로젝트가 아직 없어요 — create 로 먼저 만들어 주세요.";
  const parts: string[] = [];
  if (p.active.length > 0) parts.push(`진행 중: ${p.active.join(", ")}`);
  if (p.archived.length > 0) parts.push(`보관: ${p.archived.join(", ")}`);
  return `있는 프로젝트 — ${parts.join(" / ")}`;
}

/** 진행 중인 프로젝트 하나를 이름(없으면 열린 프로젝트)으로 찾는다. 못 찾으면 한국어 오류 결과. */
async function resolveActive(ctx: ProjectCtx, rawName: string | undefined): Promise<{ name: string } | Outcome> {
  const given = (rawName ?? "").trim() !== "";
  let want: string;
  if (given) {
    const r = safeProjectName(rawName!);
    if (!r.ok) return fail(r.error);
    want = r.name;
  } else {
    const open = ctx.activity.state.openProject;
    if (!open) return fail("열린 프로젝트가 없어요. name 으로 프로젝트를 알려 주거나 open 으로 먼저 열어 주세요.");
    want = open;
  }
  const all = await listProjects(ctx.home);
  const found = findName(all.active, want);
  if (found !== null) return { name: found };
  if (findName(all.archived, want) !== null) {
    return fail(`「${want}」 은 보관된 프로젝트예요. 보관된 프로젝트는 열거나 고칠 수 없어요(찾기에는 나와요). 보관/ 폴더에서 프로젝트/ 로 옮기면 다시 쓸 수 있어요(${ARCHIVE_DIR}/${want} → ${PROJECT_DIR}/${want}).`);
  }
  return fail(`「${want}」 프로젝트가 없어요. ${existingLine(all)}`);
}

// ───────────────────────── list ─────────────────────────

async function list(ctx: ProjectCtx): Promise<Outcome> {
  const { home } = ctx;
  const all = await listProjects(home);
  if (all.active.length === 0 && all.archived.length === 0) return { body: "프로젝트가 아직 없어요. create 로 만들어 보세요(예: name 「이사 준비」)." };
  const row = async (dir: string, name: string): Promise<string> => {
    const md = await home.read(mdRel(dir, name));
    const summary = (md !== null ? summaryFirstLine(md) : null) ?? "요약 없음";
    const last = await lastRecordDate(home, `${dir}/${name}`);
    return `- ${name} · ${clipChars(summary, LIST_SUMMARY_CHARS)} · ${last ? `마지막 기록 ${last}` : "기록 없음"}`;
  };
  const parts: string[] = [];
  if (all.active.length > 0) parts.push(`진행 중 프로젝트 (${all.active.length})\n${(await Promise.all(all.active.map((n) => row(PROJECT_DIR, n)))).join("\n")}`);
  if (all.archived.length > 0) parts.push(`보관된 프로젝트 (${all.archived.length})\n${(await Promise.all(all.archived.map((n) => row(ARCHIVE_DIR, n)))).join("\n")}`);
  return { body: parts.join("\n\n") };
}

// ───────────────────────── create ─────────────────────────

async function create(ctx: ProjectCtx, input: ProjectInput): Promise<Outcome> {
  const { home } = ctx;
  if ((input.name ?? "").trim() === "") return fail("만들 프로젝트의 이름(name)을 알려 주세요.");
  const n = safeProjectName(input.name!);
  if (!n.ok) return fail(n.error);
  const summary = cleanBody(input.text ?? "");
  const bad = checkText(summary, UPDATE_MAX_CHARS, "요약", { headings: true });
  if (bad) return bad;
  const blocked = await writeGate(home);
  if (blocked) return blocked;

  const rel = mdRel(PROJECT_DIR, n.name);
  return home.exclusive(async (): Promise<Outcome> => {
    const all = await listProjects(home);
    if (findName(all.active, n.name) !== null || findName(all.archived, n.name) !== null) {
      return fail(`「${n.name}」 프로젝트가 이미 있어요(보관된 것 포함). 다른 이름을 쓰거나 open 으로 열어 주세요. ${existingLine(all)}`);
    }
    await home.writeShared(rel, projectMdText(n.name, summary));
    return { body: `프로젝트를 만들었어요: ${rel}\n열어서 쓰려면 open(name: 「${n.name}」).`, files: [rel] };
  });
}

// ───────────────────────── open ─────────────────────────

/** open 결과의 한 절: 비었으면 (비어 있음), 너무 길면 바이트로 줄이고 파일 위치를 알린다. */
function shown(heading: string, body: string | null, max: number): string {
  const text = (body ?? "").trim();
  if (text === "") return `## ${heading}\n(비어 있음)`;
  if (bytes(text) <= max) return `## ${heading}\n${text}`;
  return `## ${heading}\n${cutBytes(text, max)}\n… 더 있어요(프로젝트.md)`;
}

async function open(ctx: ProjectCtx, input: ProjectInput): Promise<Outcome> {
  const { home, activity } = ctx;
  if ((input.name ?? "").trim() === "") {
    const before = activity.state.openProject;
    activity.state.openProject = null;
    return { body: before ? `프로젝트를 닫았어요: ${before}` : "열려 있던 프로젝트가 없어요." };
  }
  const r = await resolveActive(ctx, input.name);
  if (!("name" in r)) return r;
  const name = r.name;
  const dir = `${PROJECT_DIR}/${name}`;
  const rel = `${dir}/프로젝트.md`;
  activity.state.openProject = name;

  const md = await home.read(rel);
  // 메모 · 문서 목록 · 최근 기록을 먼저 만들어 자리를 정하고, 남는 자리를 요약 · 조건 · 사이트가 나눠 쓴다.
  const docs = (await home.list(`${dir}/문서`)).filter((f) => f.endsWith(".md") && !f.startsWith("."));
  const docLines = docs.slice(0, OPEN_DOCS_MAX).map((f) => `- 문서/${clipChars(f, DOC_NAME_CHARS)}`);
  if (docs.length > OPEN_DOCS_MAX) docLines.push(`… 외 ${docs.length - OPEN_DOCS_MAX}개`);
  const recent = (await recentRecords(home, dir, RECENT_RECORDS)).map((l) => clipChars(l, RECORD_LINE_CHARS));
  const memoLines = (md === null ? "" : (readSection(md, "메모") ?? ""))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const memoShown = memoLines.slice(-OPEN_MEMO_LINES).map((l) => clipChars(l, RECORD_LINE_CHARS));
  const tailParts = [
    `## 메모${memoLines.length > OPEN_MEMO_LINES ? ` (마지막 ${OPEN_MEMO_LINES}줄 · 전체 ${memoLines.length}줄)` : ""}\n${memoShown.length > 0 ? memoShown.join("\n") : "(비어 있음)"}`,
    `## 문서 (${docs.length}개)\n${docLines.length > 0 ? docLines.join("\n") : "(없음)"}`,
    `## 최근 기록\n${recent.length > 0 ? recent.join("\n") : "(아직 없음)"}`,
  ];
  const sections: string[] = [];
  if (md === null) {
    sections.push(`(프로젝트 문서를 찾을 수 없어요: ${rel})`);
  } else {
    const fixed = bytes(tailParts.join("\n\n")) + 400; // 절 제목 · 줄 바꿈 · 「더 있어요」 몫
    const each = Math.max(200, Math.min(OPEN_SECTION_BYTES, Math.floor((OPEN_BODY_BUDGET - fixed) / 3)));
    for (const h of ["요약", "조건", "사이트"]) sections.push(shown(h, readSection(md, h), each));
  }
  sections.push(...tailParts);
  return { body: sections.join("\n\n"), files: [rel] };
}

// ───────────────────────── update ─────────────────────────

async function update(ctx: ProjectCtx, input: ProjectInput): Promise<Outcome> {
  const { home } = ctx;
  const section = nfc((input.section ?? "") as string) as EditableSection;
  if (!(EDITABLE_SECTIONS as readonly string[]).includes(section)) return fail(`section 은 ${EDITABLE_SECTIONS.map((s) => `「${s}」`).join(" · ")} 중 하나로 알려 주세요.`);
  const mode = input.mode ?? "replace";
  if (mode !== "replace" && mode !== "append") return fail(`mode 는 「replace」(바꾸기, 기본) 나 「append」(덧붙이기) 로 알려 주세요: ${String(mode)}`);
  if (input.text === undefined) return fail("넣을 내용(text)을 알려 주세요.");
  let body = cleanBody(input.text);
  if (body === "" && mode === "append") return fail("덧붙일 내용(text)을 알려 주세요.");
  const bad = checkText(body, UPDATE_MAX_CHARS, "내용", { headings: true });
  if (bad) return bad;
  if (section === "사이트") {
    // 사이트 절은 한 줄에 주소 하나(`- https://…`)로 둔다.
    body = body
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "")
      .map((l) => (/^[-*]\s/.test(l.trim()) ? l.trim() : `- ${l.trim()}`))
      .join("\n");
  }
  const r = await resolveActive(ctx, input.name);
  if (!("name" in r)) return r;
  const blocked = await writeGate(home);
  if (blocked) return blocked;

  const rel = mdRel(PROJECT_DIR, r.name);
  return home.exclusive(async (): Promise<Outcome> => {
    const old = await home.read(rel);
    if (old === null) return fail(`프로젝트 문서를 찾을 수 없어요: ${rel}`);
    const next = mode === "append" ? appendToSection(old, section, body) : replaceSection(old, section, body);
    await home.writeShared(rel, next);
    return { body: `고쳤어요: ${rel} 의 「${section}」 (${mode === "append" ? "덧붙임" : "바꿈"})`, files: [rel] };
  });
}

// ───────────────────────── save_doc ─────────────────────────

async function saveDoc(ctx: ProjectCtx, input: ProjectInput): Promise<Outcome> {
  const { home } = ctx;
  if ((input.doc ?? "").trim() === "") return fail("저장할 문서 이름(doc)을 알려 주세요.");
  const d = safeDocName(input.doc!);
  if (!d.ok) return fail(d.error);
  const text = nfc(input.text ?? "");
  if (text.trim() === "") return fail("저장할 내용(text)을 알려 주세요.");
  const bad = checkText(text, DOC_MAX_CHARS, "문서 내용", { headings: false });
  if (bad) return bad;
  const r = await resolveActive(ctx, input.name);
  if (!("name" in r)) return r;
  const blocked = await writeGate(home);
  if (blocked) return blocked;

  const rel = `${PROJECT_DIR}/${r.name}/문서/${d.name}.md`;
  return home.exclusive(async (): Promise<Outcome> => {
    // 확인한 뒤 쓰기 직전에 다른 곳에서 보관 · 삭제됐을 수 있다 — 없는 프로젝트 폴더를 되살리지 않는다.
    if ((await home.read(mdRel(PROJECT_DIR, r.name))) === null) return fail(`「${r.name}」 프로젝트가 그사이 없어졌어요(보관됐을 수 있어요). 문서는 저장하지 않았어요.`);
    const before = await home.read(rel);
    await home.writeShared(rel, text);
    const replaced = before !== null ? ` — 기존 문서를 바꿨어요(이전 ${fmt(lenChars(before))}자 → 지금 ${fmt(lenChars(text))}자)` : "";
    return { body: `문서를 저장했어요: ${rel} (${fmt(lenChars(text))}자)${replaced}`, files: [rel] };
  });
}

// ───────────────────────── open_sites ─────────────────────────

/** body 에 덧붙임을 하나씩(빈 줄로 이어) 붙이되, 끝에 붙는 글 몫(ENVELOPE_RESERVE)을 뺀 8KB 안에서만. */
function attachWithinCap(body: string, extras: (string | Extra)[]): string {
  let text = body;
  for (const e of extras) {
    const extra: Extra = typeof e === "string" ? { text: e } : e;
    const next = `${text}\n\n${extra.text}`;
    if (bytes(next) <= OUTPUT_MAX_BYTES - ENVELOPE_RESERVE) {
      text = next;
      extra.commit?.(); // 실제로 붙은 글만 「보였음」 으로 친다
    }
  }
  return text;
}

async function openSites(ctx: ProjectCtx, input: ProjectInput): Promise<Outcome> {
  const { home } = ctx;
  const r = await resolveActive(ctx, input.name);
  if (!("name" in r)) return r;
  const rel = mdRel(PROJECT_DIR, r.name);
  const md = await home.read(rel);
  if (md === null) return fail(`프로젝트 문서를 찾을 수 없어요: ${rel}`);
  const { urls, skipped } = siteUrls(md);
  const skipNote = skipped.length > 0 ? `건너뛴 줄(http · https 주소만 열어요): ${skipped.slice(0, 5).map((s) => clipChars(s, 80)).join(" / ")}${skipped.length > 5 ? ` 외 ${skipped.length - 5}개` : ""}` : "";
  if (urls.length === 0) {
    return fail(`「${r.name}」 의 「사이트」 에 열 수 있는 주소가 없어요. update(section: 「사이트」, text: 「https://…」) 로 넣어 주세요.${skipNote ? `\n${skipNote}` : ""}`, [rel]);
  }
  if (!ctx.openTabs) return fail("사파리에 연결되어 있지 않아서 탭을 열 수 없어요.", [rel]);

  const toOpen = urls.slice(0, OPEN_SITES_MAX);
  const res = await ctx.openTabs(toOpen);
  const opened = res.output.split("\n").filter((l) => l.startsWith("열었어요: ")).length;
  const lines = [res.error !== undefined ? `사이트를 열지 못했어요: ${res.error}` : `사이트 ${opened}개를 뒤쪽 탭으로 열었어요(프로젝트 ${r.name}).`];
  if (res.output) lines.push(res.output);
  if (urls.length > toOpen.length) lines.push(`사이트가 ${urls.length}개라 앞 ${OPEN_SITES_MAX}개만 열었어요.`);
  if (skipNote) lines.push(skipNote);
  let body = lines.join("\n");

  if (ctx.recordOpened) {
    try {
      const extras = await ctx.recordOpened({ title: SITES_ENTRY_TITLE, touched: res.touched ?? [], ok: res.error === undefined, error: res.error });
      body = attachWithinCap(body, extras);
    } catch {
      // 기록 · 메모 쪽이 어떻게 되어도 연 결과는 그대로.
    }
  }
  return { body, isError: res.error !== undefined, files: [rel] };
}

// ───────────────────────── archive ─────────────────────────

async function archive(ctx: ProjectCtx, input: ProjectInput): Promise<Outcome> {
  const { home, activity } = ctx;
  const r = await resolveActive(ctx, input.name);
  if (!("name" in r)) return r;
  const blocked = await writeGate(home);
  if (blocked) return blocked;

  const name = r.name;
  const from = home.path(PROJECT_DIR, name);
  return home.exclusive(async (): Promise<Outcome> => {
    const taken = new Set((await home.list(ARCHIVE_DIR)).map((n) => n.toLowerCase()));
    let dest = name;
    for (let k = 2; taken.has(dest.toLowerCase()); k++) dest = `${name}-${k}`;
    await mkdir(home.path(ARCHIVE_DIR), { recursive: true });
    try {
      await rename(from, home.path(ARCHIVE_DIR, dest));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return fail(`「${name}」 폴더가 그사이 없어졌어요.`);
      throw e;
    }
    // 옮기기가 끝난 뒤에 옮겨진 파일의 상태를 바꾼다 — 옮기기가 실패하면 진행 중 프로젝트는 그대로다.
    let stateNote = "";
    try {
      const moved = mdRel(ARCHIVE_DIR, dest);
      const md = await home.read(moved);
      if (md !== null) await home.writeShared(moved, replaceSection(md, "상태", "보관"));
    } catch {
      stateNote = "\n(옮기기는 끝났지만 프로젝트.md 의 「상태」 를 보관으로 못 바꿨어요)";
    }
    const open = activity.state.openProject;
    if (open !== null && open.toLowerCase() === name.toLowerCase()) activity.state.openProject = null;
    const note = dest === name ? "" : ` (같은 이름이 이미 있어 「${dest}」 로)`;
    return { body: `보관했어요: ${ARCHIVE_DIR}/${dest}${note}\n보관한 프로젝트는 list 의 보관 칸과 찾기에서 볼 수 있어요.${stateNote}`, files: [mdRel(ARCHIVE_DIR, dest)] };
  });
}

// ───────────────────────── 진입점 ─────────────────────────

/**
 * project 도구 한 번. MCP 와 떨어져 있어 그대로 시험할 수 있다.
 * 결과는 항상 8,192 바이트 이하, 열린 프로젝트가 있으면 첫 줄에 이름, 다룬 파일에 충돌본이 있으면 끝 줄에 알림, 정리 안내는 대화당 한 번.
 */
export async function runProjectTool(ctx: ProjectCtx, input: ProjectInput): Promise<ToolResult> {
  ctx.activity.touch();
  let out: Outcome;
  try {
    switch (input.action) {
      case "list":
        out = await list(ctx);
        break;
      case "create":
        out = await create(ctx, input);
        break;
      case "open":
        out = await open(ctx, input);
        break;
      case "update":
        out = await update(ctx, input);
        break;
      case "save_doc":
        out = await saveDoc(ctx, input);
        break;
      case "open_sites":
        out = await openSites(ctx, input);
        break;
      case "archive":
        out = await archive(ctx, input);
        break;
      default:
        out = fail(`알 수 없는 action 이에요: ${String((input as { action: unknown }).action)}`);
    }
  } catch (e) {
    out = fail(`프로젝트 도구가 실패했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
  return composeResult(ctx, out.body, { isError: out.isError, files: out.files });
}
