/**
 * 탭 확인과 일을 한 번의 doJavaScript 로 하는 글(스크립트)을 만든다. 호스트 op `runJsFast` · `showTab` 이 이 글을 사파리에 그대로 보낸다.
 *
 * 글이 페이지 안에서 하는 일(예전 호스트의 probeTab → guardTab → stampTab → doJavaScript 를 한 번에):
 *   1) 탭 표시(`document.documentElement.dataset.saTab`)를 읽는다 — 읽지 못하면(documentElement 가 없는 문서 등) 표시 없음으로 본다.
 *   2) 표시가 키와 같으면 그대로, 표시가 없고 아직 표시를 안 한 탭(unstamped)이면서 문서 자신의 주소(location.href)가
 *      기록한 주소(url) 또는 대신 받아들일 주소(altUrl)와 같으면 표시를 적고 간다. 적지 못해도 간다(예전과 같다).
 *   3) 그 밖에는 소스를 돌리지 않고 `{ok:false}` 를 돌려준다(호스트가 느린 길로 다시 확인한다).
 *   4) 소스(식 하나)를 돌려 값을 글로 바꾸고 `{ok:true, type, value, url, leaving}` 을 돌려준다(leaving = `window.__saLeaving === true`, 동작 뒤 이동 확인을 줄이는 데 쓴다). url 은 문서 자신의 location.href 다 —
 *      사파리의 tab.url() 은 이동이 진행 중일 때 가는 중인 목적지를 돌려주므로 쓰지 않는다.
 *
 * 값 바꾸기는 예전 호스트와 같다: 글은 그대로, 숫자 · 불리언은 String, null · undefined 는 빈 글, 그 밖은 JSON.stringify(없으면 빈 글).
 * 소스가 던진 오류는 삼키지 않는다 — 사파리가 이 스크립트를 null 로 돌려주고(예전에 소스만 돌렸을 때와 같다) 호스트가 따로 다룬다.
 *
 * 소스는 식 하나여야 한다(`(` 소스 `\n)` 로 끼운다 — 문장 · 선언은 안 된다). 페이지 안에서 문자열을 eval 하지 않고 소스를 글에 그대로 끼워 넣으므로
 * 엄격한 CSP 에서도 돈다. 이 글의 지역 이름은 `__sa` 로 시작해 페이지 전역 · 소스 안의 이름과 부딪치지 않게 한다.
 */

import { urlForms } from "./url.js";

export interface GuardSpec {
  /** 페이지 안에 적는 탭 표시(TabRegistry.markerOf). */
  key: string;
  /** 아직 페이지에 표시를 안 했다(주소로만 알아본다). */
  unstamped: boolean;
  /** 기록한 주소. */
  url: string;
  /** 표시 안 한 탭을 알아볼 때 url 말고 받아들일 주소. */
  altUrl?: string;
}

/** 값 종류 꼬리표: 글 · 숫자 · 불리언은 typeof, null · undefined 는 "null", 그 밖(객체 · 함수 · 기호 · 큰 정수)은 typeof 그대로. */
export type ValueType = "string" | "number" | "boolean" | "null" | "object" | "function" | "symbol" | "bigint";

/** 한 번의 doJavaScript 가 돌려주는 글(JSON)의 꼴. */
export type GuardedReading = { ok: true; type: ValueType; value: string; url: string; /** 문서를 떠나는 중인가(`window.__saLeaving`, beforeunload 때 Page 의 동작 코드가 세운 깃발). */ leaving: boolean } | { ok: false; marker: string; url: string };

export function buildGuardedSource(g: GuardSpec, source: string): string {
  // 문서 주소(location.href)는 기록한 주소와 꼴이 다를 수 있어(끝 슬래시 · 퍼센트 인코딩) 같은 주소의 여러 꼴 중 하나와 같으면 된다.
  const here = g.unstamped ? `__saM === '' && ${JSON.stringify(urlForms([g.url, g.altUrl]))}.indexOf(location.href) >= 0` : "false";
  return `(function(__saK){
var __saM = '';
try { __saM = String(document.documentElement.dataset.saTab || ''); } catch (__saE) {}
if (__saM !== __saK) {
  if (!(${here})) return JSON.stringify({ ok: false, marker: __saM, url: location.href });
  try { document.documentElement.dataset.saTab = __saK; } catch (__saE) {}
}
var __saV = (${source}
);
var __saT = __saV === null || __saV === undefined ? 'null' : typeof __saV;
var __saS = __saT === 'null' ? '' : __saT === 'string' ? __saV : __saT === 'number' || __saT === 'boolean' ? String(__saV) : JSON.stringify(__saV);
return JSON.stringify({ ok: true, type: __saT, value: typeof __saS === 'string' ? __saS : '', url: location.href, leaving: window.__saLeaving === true });
})(${JSON.stringify(g.key)})`;
}

/**
 * 소스가 식 하나인가 — buildGuardedSource 가 끼우는 꼴 그대로 문법을 본다(실행하지 않는다). 식 둘레를 닫고 문장을 끼워 넣는 소스(`0); x(); (0`)도 걸러내려고
 * 감싼 함수 꼴 `var v = (소스\n);` 와 배열 꼴 `[(소스\n)]` 가 모두 문법에 맞아야 한다(앞의 것만으로는 `(0); x(); (0)` 이 통과한다). 아니면 오류 메시지.
 */
export function expressionError(source: string): string | null {
  try {
    new Function(`var __saV = (${source}\n);`);
    new Function(`return [(${source}\n)];`);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
