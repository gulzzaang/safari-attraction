import { stat } from "node:fs/promises";
import { MemoryHome, localDate, localTime, machineName } from "./home.js";
import { scrubText } from "./guard.js";
import { sanitizeUrl, siteFileName, siteLookupChain } from "./site.js";

/** repl 호출 한 번에서 사파리가 닿은 곳. kind: open = openTab · openAiWindow, attach = attachBrowserTab · attachActiveBrowserTab, nav = 열려 있던 탭이 옮겨 감. */
export type Touch = { url: string; userTab: boolean; kind: "open" | "nav" | "attach" };

/** 한 대화(마지막 사용 뒤 30분 안) 동안 이어지는 서버 쪽 상태. */
export type SessionState = {
  openProject: string | null;
  paused: boolean;
  /** 이번 대화에서 사이트 메모를 이미 보여 준(또는 메모가 없던) 도메인. */
  seenDomains: Set<string>;
  tidyHinted: boolean;
  pendingTidy: { files: string[]; at: number } | null;
  lastUse: number;
  /** 「기억 폴더에 쓸 수 없어요」 안내를 이미 한 번 했는가(대화당 한 번). */
  writeWarned: boolean;
};

/**
 * 응답에 붙일 글 하나. 「보였음」 표시(commit)는 글이 실제로 응답에 붙은 뒤에 부른 쪽이 한다 — 상한에 막혀 빠졌거나 기다리다 포기했으면 부르지 않아 다음 호출에서 다시 나온다.
 */
export type Extra = { text: string; commit?: () => void };

/** 마지막 사용 뒤 이만큼(밀리초) 지나면 새 대화로 보고 상태를 처음으로. */
export const IDLE_RESET_MS = 1_800_000;
/** 사이트 메모 자동 붙이기 상한(글자 수, 여러 도메인 합쳐서). */
export const SITE_NOTE_MAX = 600;
const TIDY_INTERVAL_MS = 24 * 3600_000;
const TITLE_MAX = 60;
const REASON_MAX = 80;
const TIDY_HINT = "… 기억 정리할 때가 됐어요 — memory 도구 tidy";

const initialState = (now: number): SessionState => ({
  openProject: null,
  paused: false,
  seenDomains: new Set(),
  tidyHinted: false,
  pendingTidy: null,
  lastUse: now,
  writeWarned: false,
});

const clip = (s: string, max: number): string => {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
};

// ───────────────────────── 맥별 상태 파일 ─────────────────────────

const machineStateRel = () => `기억/.상태-${machineName()}.json`;

/** `기억/.상태-<맥>.json` — 맥마다 따로 갖는 작은 상태. 없거나 깨졌으면 {}. */
export async function readMachineState(home: MemoryHome): Promise<{ lastTidy?: string }> {
  let raw: string | null;
  try {
    raw = await home.read(machineStateRel());
  } catch {
    return {};
  }
  if (raw === null) return {};
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const lastTidy = (j as { lastTidy?: unknown }).lastTidy;
      return typeof lastTidy === "string" ? { lastTidy } : {};
    }
  } catch {
    // 깨진 파일은 없는 것으로.
  }
  return {};
}

/** 기존 값에 patch 를 합쳐 임시 파일에 쓴 뒤 이름을 바꿔 저장한다. */
export async function writeMachineState(home: MemoryHome, patch: { lastTidy?: string }): Promise<void> {
  const merged = { ...(await readMachineState(home)), ...patch };
  await home.writeShared(machineStateRel(), JSON.stringify(merged, null, 2) + "\n");
}

// ───────────────────────── 활동 기록 ─────────────────────────

/** %EC%84%9C 같은 퍼센트 부호를 읽을 수 있게 풀어 쓴다(찾기에 걸리도록). 풀면 공백 · 줄 바꿈이 생기거나 깨진 부호면 그대로 둔다. */
function readable(s: string): string {
  try {
    const dec = decodeURI(s);
    return /[\s\u0000-\u001f]/.test(dec) ? s : dec;
  } catch {
    return s;
  }
}

/** 사이트 메모를 같은 도메인끼리 한 번만 보이려고 호스트에서 뽑는 열쇠(www. · m. 뗀 소문자). 주소가 아니면 null. */
function hostKey(url: string): string | null {
  if (/^(about|file|data|blob):/i.test(url)) return null;
  try {
    const host = new URL(url).hostname;
    if (!host) return null;
    return siteFileName(host).replace(/\.md$/, "");
  } catch {
    return null;
  }
}

export class ActivityLog {
  state: SessionState;

  constructor(
    private readonly home: MemoryHome,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = initialState(this.now().getTime());
  }

  /** 도구 호출이 시작될 때 부른다. 마지막 사용 뒤 30분이 넘었으면 상태를 처음으로(같은 객체를 제자리에서) 되돌리고 시각을 갱신한다. */
  touch(): void {
    const t = this.now().getTime();
    if (t - this.state.lastUse > IDLE_RESET_MS) Object.assign(this.state, initialState(t));
    this.state.lastUse = t;
  }

  /**
   * 하루 기록 한 줄(열린 프로젝트가 있으면 프로젝트 기록에도). 닿은 곳이 없고 성공이면 아무것도 안 쓴다. paused 면 안 쓴다.
   * 쓰기가 실패하면 던진다 — 부른 쪽이 repl 결과를 망치지 않게 잡아야 한다.
   */
  async record(entry: { title: string; touched: Touch[]; ok: boolean; error?: string }): Promise<void> {
    if (this.state.paused) return;
    if (entry.touched.length === 0 && entry.ok) return;
    const when = this.now();
    const title = scrubText(entry.title, TITLE_MAX).trim() || "(제목 없음)";
    const sites = [...new Set(entry.touched.map((t) => readable(sanitizeUrl(t.url, { domainOnly: t.userTab }))))];
    const result = entry.ok ? "성공" : `실패(${scrubText(entry.error ?? "", REASON_MAX)})`;
    let project = this.state.openProject;
    if (project && !(await this.projectExists(project))) {
      // 열어 둔 프로젝트가 그사이 보관 · 삭제됐다 — 프로젝트 기록으로 폴더를 되살리지 않고 열린 프로젝트를 닫는다(하루 기록은 쓴다).
      this.state.openProject = null;
      project = null;
    }
    const line = `- ${localTime(when)} 「${title}」 — ${sites.length > 0 ? sites.join(", ") : "(닿은 사이트 없음)"} · ${result}${project ? ` · 프로젝트: ${project}` : ""}\n`;
    const mac = machineName();
    let failure: unknown;
    try {
      await this.home.append(`기억/일지/${localDate(when)}-${mac}.md`, line);
    } catch (e) {
      failure = e;
    }
    if (project) {
      try {
        // 프로젝트 기록은 맥마다 한 파일에 계속 쌓이니 줄마다 날짜를 단다(`- 날짜 시각 …`). project 도구의 「최근 기록」 · 「마지막 기록」 이 읽는다.
        await this.home.append(`프로젝트/${project}/기록-${mac}.md`, `- ${localDate(when)} ${line.slice(2)}`);
      } catch (e) {
        failure ??= e;
      }
    }
    if (failure !== undefined) throw failure;
  }

  /** 진행 중 프로젝트의 `프로젝트.md` 가 있는가(한 번 stat). */
  private async projectExists(name: string): Promise<boolean> {
    try {
      return (await stat(this.home.path(`프로젝트/${name}/프로젝트.md`))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 이번 대화에서 처음 닿은 도메인의 사이트 메모(`기억/사이트/`)를 한 줄씩 `… 이 사이트 메모(도메인): 내용` 으로, 모두 합쳐 600자 안.
   * 글만 만들고 「보였음」 표시는 돌려주는 commit() 이 한다(글이 실제로 붙은 뒤에 부를 것). 메모 파일이 없는 도메인은 붙일 글이 없으니 바로 본 것으로 친다(다시 읽지 않는다).
   * 붙일 것이 없으면 null.
   */
  async planSiteNote(touched: Touch[]): Promise<{ text: string; commit: () => void } | null> {
    const notes: string[] = [];
    const attached: string[] = [];
    let used = 0;
    for (const t of touched) {
      const key = hostKey(t.url);
      if (key === null || this.state.seenDomains.has(key) || attached.includes(key)) continue;
      const body = await this.findSiteMemo(key);
      if (body === null) {
        this.state.seenDomains.add(key);
        continue;
      }
      const head = `… 이 사이트 메모(${key}): `;
      const sep = notes.length > 0 ? 1 : 0; // 줄 바꿈
      const room = SITE_NOTE_MAX - used - sep - [...head].length;
      if (room < 1) continue; // 자리가 없다 — 다음 기회에 보이도록 본 것으로 치지 않는다
      notes.push(head + clip(body, room));
      used += sep + [...notes[notes.length - 1]!].length;
      attached.push(key);
    }
    if (notes.length === 0) return null;
    return {
      text: notes.join("\n"),
      commit: () => {
        for (const k of attached) this.state.seenDomains.add(k);
      },
    };
  }

  /** planSiteNote 를 부르고 곧바로 「보였음」 으로 친다(붙이는 자리가 따로 없을 때). */
  async siteNoteFor(touched: Touch[]): Promise<string | null> {
    const plan = await this.planSiteNote(touched);
    plan?.commit();
    return plan?.text ?? null;
  }

  private async findSiteMemo(key: string): Promise<string | null> {
    for (const name of siteLookupChain(key)) {
      let text: string | null;
      try {
        text = await this.home.read(`기억/사이트/${name}`);
      } catch {
        continue; // 읽을 수 없는 메모는 없는 것으로(조용히)
      }
      const flat = text?.replace(/\s+/g, " ").trim();
      if (flat) return flat;
    }
    return null;
  }

  /**
   * 정리 안내 한 줄: 이 맥의 마지막 정리(`lastTidy`)가 없거나 24시간이 넘었고, 오늘보다 이전 날짜의 `기억/일지/*.md`(보관/ 제외)가 있고,
   * 이번 대화에 아직 안 보였을 때만. 글만 만들고 tidyHinted 는 commit() 이 켠다(글이 실제로 붙은 뒤에 부를 것).
   */
  async planTidyHint(): Promise<{ text: string; commit: () => void } | null> {
    if (this.state.tidyHinted) return null;
    const { lastTidy } = await readMachineState(this.home);
    const last = lastTidy ? Date.parse(lastTidy) : Number.NaN;
    if (Number.isFinite(last) && this.now().getTime() - last <= TIDY_INTERVAL_MS) return null;
    const today = localDate(this.now());
    const names = await this.home.list("기억/일지");
    const older = names.some((n) => {
      const m = /^(\d{4}-\d{2}-\d{2})-.*\.md$/.exec(n);
      return m !== null && m[1]! < today;
    });
    if (!older) return null;
    return {
      text: TIDY_HINT,
      commit: () => {
        this.state.tidyHinted = true;
      },
    };
  }

  /** planTidyHint 를 부르고 곧바로 「보였음」 으로 친다. */
  async tidyHint(): Promise<string | null> {
    const plan = await this.planTidyHint();
    plan?.commit();
    return plan?.text ?? null;
  }

  /**
   * 기록 쓰기가 실패했을 때 응답에 붙일 한 줄(대화당 한 번, 이미 알렸으면 null). 이유는 폴더를 다시 써 보고 얻는다(그것도 못 하면 원래 오류 글).
   * 「알렸다」 표시는 글이 실제로 만들어진 뒤에 한다.
   */
  async writeFailureNotice(error: unknown): Promise<string | null> {
    if (this.state.writeWarned) return null;
    const original = error instanceof Error ? error.message : String(error);
    let reason = original;
    try {
      const w = await this.home.writable();
      if (!w.ok) reason = w.reason;
    } catch {
      // 이유를 알아볼 수 없으면 원래 오류 글로.
    }
    if (this.state.writeWarned) return null; // 기다리는 사이 다른 호출이 먼저 알렸다
    const line = `기억 폴더에 쓸 수 없어요: ${this.home.dir} — ${reason}`;
    this.state.writeWarned = true;
    return line;
  }
}
