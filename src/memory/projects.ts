import { stat } from "node:fs/promises";
import { MemoryHome, nfc } from "./home.js";
import { readSection } from "./sections.js";

/** 프로젝트 폴더 모음. 보관한 프로젝트는 그 아래 `보관/` 으로 옮겨진다. */
export const PROJECT_DIR = "프로젝트";
export const ARCHIVE_NAME = "보관";
export const ARCHIVE_DIR = `${PROJECT_DIR}/${ARCHIVE_NAME}`;

/** update 로 고칠 수 있는 절. `## 상태` 는 도구가 관리한다(진행 중 | 보관). */
export const EDITABLE_SECTIONS = ["요약", "조건", "사이트", "메모"] as const;
export type EditableSection = (typeof EDITABLE_SECTIONS)[number];

const NAME_MAX = 64;

export type NameResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * 폴더 · 파일 이름으로 쓸 수 있게 다듬는다: NFC, 앞뒤 공백 제거, `/` `\` `:` 는 `-`.
 * 빈 이름 · `..` 이 든 이름 · 점으로 시작 · 제어 문자 · 64자(코드 포인트) 초과는 한국어 오류 — 자르지 않는다(잘라서 서로 다른 이름이 같아지면 안 된다).
 */
function safeName(raw: string, what: string): NameResult {
  const name = nfc(raw).trim().replace(/[/\\:]/g, "-");
  if (name === "") return { ok: false, error: `${what}을 알려 주세요.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: `${what}에 제어 문자는 쓸 수 없어요.` };
  if (name.includes("..")) return { ok: false, error: `${what}에 「..」 은 쓸 수 없어요: ${name}` };
  if (name.startsWith(".")) return { ok: false, error: `${what}은 점(.)으로 시작할 수 없어요: ${name}` };
  const len = [...name].length;
  if (len > NAME_MAX) return { ok: false, error: `${what}이 너무 길어요(${NAME_MAX}자까지): ${len}자 — 더 짧게 지어 주세요.` };
  return { ok: true, name };
}

/** 프로젝트 이름. 「보관」 은 보관 폴더 이름이라 쓸 수 없다. */
export function safeProjectName(raw: string): NameResult {
  const r = safeName(raw, "프로젝트 이름");
  if (r.ok && r.name === ARCHIVE_NAME) return { ok: false, error: `「${ARCHIVE_NAME}」 은 보관 폴더 이름이라 프로젝트 이름으로 쓸 수 없어요.` };
  return r;
}

/** 문서 이름(`문서/<이름>.md`). 끝의 `.md` 는 떼고 같은 규칙을 적용한다. */
export function safeDocName(raw: string): NameResult {
  return safeName(nfc(raw).trim().replace(/\.md$/i, ""), "문서 이름");
}

/** 새 `프로젝트.md`. */
export function projectMdText(name: string, summary: string): string {
  const body = summary.trim();
  return `# ${name}\n\n## 요약\n${body ? `${body}\n` : ""}\n## 조건\n\n## 사이트\n\n## 메모\n\n## 상태\n진행 중\n`;
}

// ───────────────────────── 목록 ─────────────────────────

async function isDir(home: MemoryHome, rel: string): Promise<boolean> {
  try {
    return (await stat(home.path(rel))).isDirectory();
  } catch {
    return false;
  }
}

async function dirsUnder(home: MemoryHome, relDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const n of await home.list(relDir)) {
    if (n.startsWith(".")) continue;
    if (relDir === PROJECT_DIR && n === ARCHIVE_NAME) continue;
    if (await isDir(home, `${relDir}/${n}`)) out.push(n);
  }
  return out;
}

/** 진행 중 · 보관된 프로젝트 이름(NFC, 정렬). 보관 폴더 · 파일 · 점 이름은 빼고 폴더만. */
export async function listProjects(home: MemoryHome): Promise<{ active: string[]; archived: string[] }> {
  return { active: await dirsUnder(home, PROJECT_DIR), archived: await dirsUnder(home, ARCHIVE_DIR) };
}

/** names 에서 name 을 찾는다: 이름이 똑같은 것, 없으면 대소문자만 다른 것(맥 폴더는 대소문자를 구별하지 않아 같은 폴더가 된다). */
export function findName(names: string[], name: string): string | null {
  const n = nfc(name);
  const exact = names.find((x) => x === n);
  if (exact !== undefined) return exact;
  const lower = n.toLowerCase();
  return names.find((x) => x.toLowerCase() === lower) ?? null;
}

// ───────────────────────── 기록 ─────────────────────────

/** 프로젝트 기록 줄: `- YYYY-MM-DD HH:MM 「…」 — …`. 날짜가 없는 줄(예전 꼴)은 읽지 않는다. */
const RECORD_LINE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) /;

type Rec = { key: string; date: string; line: string; file: string; idx: number };

/** `<dirRel>/기록-*.md`(모든 맥) 의 날짜 있는 줄 전부. 같은 줄이 겹치면(iCloud 충돌본) 한 번만. */
async function readRecords(home: MemoryHome, dirRel: string): Promise<Rec[]> {
  const out: Rec[] = [];
  const seen = new Set<string>();
  for (const file of await home.list(dirRel)) {
    if (!/^기록-.*\.md$/.test(file)) continue;
    const text = await home.read(`${dirRel}/${file}`);
    if (text === null) continue;
    text.split("\n").forEach((raw, idx) => {
      const line = raw.replace(/\r$/, "");
      const m = RECORD_LINE.exec(line);
      if (!m || seen.has(line)) return;
      seen.add(line);
      out.push({ key: `${m[1]} ${m[2]}`, date: m[1]!, line, file, idx });
    });
  }
  return out;
}

/** 최근 기록 n줄: 모든 맥의 기록을 날짜 · 시각 최신순으로. 같은 시각이면 파일의 뒤쪽 줄이 먼저. */
export async function recentRecords(home: MemoryHome, dirRel: string, n: number): Promise<string[]> {
  const all = await readRecords(home, dirRel);
  all.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : a.file < b.file ? -1 : a.file > b.file ? 1 : b.idx - a.idx));
  return all.slice(0, n).map((r) => r.line);
}

/** 마지막 기록 날짜(`YYYY-MM-DD`). 기록이 없으면 null. */
export async function lastRecordDate(home: MemoryHome, dirRel: string): Promise<string | null> {
  let best: string | null = null;
  for (const r of await readRecords(home, dirRel)) if (best === null || r.date > best) best = r.date;
  return best;
}

// ───────────────────────── 프로젝트.md 읽기 ─────────────────────────

/** 요약 절의 첫 글 줄(없으면 null). */
export function summaryFirstLine(md: string): string | null {
  const body = readSection(md, "요약");
  if (!body) return null;
  return body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? null;
}

/** 사이트 절에서 열 수 있는 주소(http · https, 같은 주소는 한 번)와 건너뛴 줄. 줄은 `- https://…`(뒤에 설명이 붙어도 첫 낱말이 주소면 연다). */
export function siteUrls(md: string): { urls: string[]; skipped: string[] } {
  const urls: string[] = [];
  const skipped: string[] = [];
  for (const raw of (readSection(md, "사이트") ?? "").split("\n")) {
    const item = raw.trim().replace(/^[-*]\s+/, "");
    if (item === "") continue;
    const token = item.split(/\s+/)[0]!;
    let ok = false;
    if (/^https?:\/\//i.test(token)) {
      try {
        const u = new URL(token);
        ok = (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
      } catch {
        ok = false;
      }
    }
    if (!ok) skipped.push(item);
    else if (!urls.includes(token)) urls.push(token);
  }
  return { urls, skipped };
}
