import { nfc } from "./home.js";

/**
 * 마크다운 `## 제목` 절 다루기. 절은 `## 제목` 줄부터 다음 `## ` 줄(또는 파일 끝) 앞까지다.
 * `### ` 이하 작은 제목은 절을 끊지 않는다. 같은 제목이 여럿이면 처음 것만 본다.
 */

const HEADING = /^## (.*?)\s*$/;

const norm = (s: string) => nfc(s).trim();

/** 줄 단위로 쪼개고 첫 번째 `## heading` 줄의 위치 [시작, 끝) 를 찾는다. 끝은 다음 `## ` 줄(없으면 줄 수). */
function locate(lines: string[], heading: string): { start: number; end: number } | null {
  const want = norm(heading);
  const start = lines.findIndex((l) => {
    const m = HEADING.exec(l);
    return m !== null && norm(m[1]!) === want;
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 절 본문 줄들(제목 줄 다음부터 절 끝까지)에서 뒤쪽 빈 줄을 뺀 길이. */
function trimmedEnd(lines: string[], from: number, end: number): number {
  let e = end;
  while (e > from && lines[e - 1]!.trim() === "") e--;
  return e;
}

/** 글 끝에 새 절을 붙인다(앞에 빈 줄 하나, 끝은 줄 바꿈으로). */
function addAtEnd(md: string, heading: string, bodyLines: string[]): string {
  const lines = md.length === 0 ? [] : md.replace(/\n$/, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length > 0) lines.push("");
  lines.push(`## ${norm(heading)}`, ...bodyLines);
  return lines.join("\n") + "\n";
}

/** 절 본문(앞뒤 빈 줄 뺀 것). 그 절이 없으면 null. */
export function readSection(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const at = locate(lines, heading);
  if (!at) return null;
  let s = at.start + 1;
  while (s < at.end && lines[s]!.trim() === "") s++;
  const e = trimmedEnd(lines, s, at.end);
  return lines.slice(s, e).join("\n").replace(/\r$/gm, "");
}

/** 절 본문을 통째로 바꾼다. 절이 없으면 글 끝에 새로 만든다. 다른 절은 그대로. */
export function replaceSection(md: string, heading: string, body: string): string {
  const bodyLines = body.replace(/^\n+|\s+$/g, "").split("\n");
  const content = body.trim() === "" ? [] : bodyLines;
  const lines = md.split("\n");
  const at = locate(lines, heading);
  if (!at) return addAtEnd(md, heading, content);
  const before = lines.slice(0, at.start + 1);
  const after = lines.slice(at.end);
  const out = [...before, ...content];
  if (after.length > 0) {
    out.push("");
    out.push(...after);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

/** 절 맨 끝에 한 줄을 덧붙인다(절 안 마지막 글 줄 바로 아래). 절이 없으면 글 끝에 새로 만든다. */
export function appendToSection(md: string, heading: string, line: string): string {
  const lines = md.split("\n");
  const at = locate(lines, heading);
  if (!at) return addAtEnd(md, heading, [line]);
  const e = trimmedEnd(lines, at.start + 1, at.end);
  const out = [...lines.slice(0, e), line, ...lines.slice(e)];
  return out.join("\n").replace(/\n*$/, "\n"); // 글 끝은 항상 줄 바꿈 하나.
}
