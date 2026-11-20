import { normTimeout } from "./locator.js";

/** Playwright 의 waitUntil · waitForLoadState 상태. commit 은 goto 에서만(주소가 바뀌는 즉시). */
export type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";
export type LoadState = Exclude<WaitUntil, "commit">;

const LOAD_STATES: readonly string[] = ["domcontentloaded", "load", "networkidle"];
const WAIT_UNTILS: readonly string[] = ["commit", ...LOAD_STATES];

/** 이동 · 열기 뒤 기본으로 기다리는 때: 문서를 쓸 수 있을 때(Playwright 의 domcontentloaded). */
export const DEFAULT_NAV_WAIT: WaitUntil = "domcontentloaded";
/** 불러오기를 기다리는 기본 시간(밀리초). */
export const LOAD_TIMEOUT_MS = 15000;
/** networkidle: 새 네트워크 요청이 이 시간 동안 없어야 한다. */
export const NETWORK_IDLE_MS = 500;

/** waitUntil 값을 바로잡는다. 안 줬으면 기본(domcontentloaded). allowCommit 이 아니면 commit 은 오류. */
export function parseWaitUntil(v: unknown, who: string, allowCommit: boolean): WaitUntil {
  if (v === undefined || v === null) return DEFAULT_NAV_WAIT;
  const ok = allowCommit ? WAIT_UNTILS : LOAD_STATES;
  if (typeof v !== "string" || !ok.includes(v)) {
    throw new Error(`${who}: waitUntil 은 ${ok.map((s) => `'${s}'`).join(" · ")} 중 하나여야 해요(받은 값: ${typeof v === "string" ? `'${v}'` : String(v)})`);
  }
  return v as WaitUntil;
}

/**
 * waitForLoadState 의 인자를 풀어 낸다. 상태를 안 주면 load(Playwright 와 같다).
 * 옛 호출 꼴 waitForLoadState(밀리초)와 waitForLoadState({timeout}) 도 받는다.
 */
export function parseLoadStateArgs(a: unknown, b: unknown): { state: LoadState; timeoutMs: number } {
  let state: unknown;
  let timeout: unknown;
  if (typeof a === "number") timeout = a;
  else if (a !== undefined && a !== null && typeof a === "object") timeout = (a as { timeout?: unknown }).timeout;
  else {
    state = a;
    if (b !== undefined && b !== null && typeof b === "object") timeout = (b as { timeout?: unknown }).timeout;
  }
  const st = state === undefined || state === null ? "load" : (parseWaitUntil(state, "waitForLoadState", false) as LoadState);
  return { state: st, timeoutMs: normTimeout(timeout, LOAD_TIMEOUT_MS) };
}

/** 한 번 읽은 값: readyState · body 가 있는가 · DOMContentLoaded 이벤트가 끝났는가 · 지금까지 받은 리소스 수와 마지막 리소스의 끝난 때(networkidle 이 변화를 알아보는 표). */
export interface LoadReading {
  readyState: string;
  hasBody: boolean;
  dclDone: boolean;
  sig: string;
}

/** 문서를 쓸 수 있는가(host.js 의 usableState 와 같은 뜻): DOMContentLoaded 가 끝나고 body 가 있거나, readyState 가 complete. */
export const usable = (r: LoadReading): boolean => r.readyState === "complete" || (r.hasBody && r.dclDone);

/** 페이지 안에서 읽는 식. 결과는 `readyState|body|DCL 끝남|리소스 수|마지막 끝난 때`. networkidle 만 리소스를 본다. */
export function loadPollSource(state: LoadState): string {
  const base = "document.readyState + '|' + (document.body ? 1 : 0) + '|' + (((performance.getEntriesByType('navigation')[0] || {}).domContentLoadedEventEnd || 0) > 0 ? 1 : 0)";
  if (state !== "networkidle") return base;
  // 리소스 기록 칸(기본 250개)이 차면 새 요청이 기록에 안 남아 변화를 못 보므로 칸을 키워 둔다.
  return `(function(){try{if(performance.setResourceTimingBufferSize)performance.setResourceTimingBufferSize(2000)}catch(e){}var r=performance.getEntriesByType('resource');var l=r[r.length-1];return ${base} + '|' + r.length + '|' + (l ? Math.round(l.responseEnd) : 0)})()`;
}

/** loadPollSource 의 답을 읽는다. 모르는 꼴(옛 시험 답 `complete` 등)도 앞부분만 보고 받아들인다. */
export function parseLoadReading(raw: string): LoadReading {
  const p = String(raw).split("|");
  // 옛 꼴(DCL 칸이 없는 답)은 readyState 가 loading 이 아니면 끝난 것으로 본다.
  const dclDone = p[2] === undefined ? p[0] !== "loading" : p[2] === "1";
  return { readyState: p[0] ?? "", hasBody: p[1] === undefined ? true : p[1] === "1", dclDone, sig: p.slice(3).join("|") };
}

/** 상태에 닿았나. networkidle 은 순서를 지켜 부른 쪽이 idle 을 따로 센다(LoadWatch). */
export function reached(state: Exclude<LoadState, "networkidle">, r: LoadReading): boolean {
  return state === "load" ? r.readyState === "complete" : usable(r);
}

/**
 * networkidle 판단: load 가 끝난 뒤 새 리소스 기록이 NETWORK_IDLE_MS 동안 없어야 한다.
 * 한 번 읽을 때마다 feed(읽은 값, 지금 시각)를 부르고, true 면 끝. 시각은 부르는 쪽이 준다(시험하기 쉽게).
 */
export class IdleWatch {
  private lastSig: string | undefined;
  private since = 0;
  feed(r: LoadReading, now: number): boolean {
    if (r.readyState !== "complete" || r.sig !== this.lastSig || this.lastSig === undefined) {
      this.lastSig = r.sig;
      this.since = now;
      return false;
    }
    return now - this.since >= NETWORK_IDLE_MS;
  }
}

/** 시간 초과 오류 글. */
export function loadTimeoutMessage(state: WaitUntil, timeoutMs: number): string {
  const what = { commit: "이동하지 않음", domcontentloaded: "쓸 수 있게 되지 않음", load: "다 뜨지 않음", networkidle: "네트워크가 잠잠해지지 않음" }[state];
  return `페이지가 ${timeoutMs}ms 안에 ${what}(${state})`;
}
