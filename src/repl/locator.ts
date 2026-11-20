/**
 * Playwright 식 Locator. 찾는 방법은 「단계 목록(chain)」으로 들고 있다가, 동작할 때 통째로 페이지에 보내 거기서 찾고 바로 동작한다
 * (inpage-locator.ts). 엄격하지 않다 — 여러 개가 맞으면 동작은 화면에 보이는 첫 번째에 하고, count() · all() 은 전부를 본다.
 */

import type { ActionOk, ActionOp } from "./inpage-actions.js";

export type Matcher = { s: string } | { re: string; fl: string };

/** 찾기 단계 하나. 앞 단계의 결과 안(없으면 문서 전체)에서 이어서 좁힌다. */
export type Step =
  | { k: "css" | "ref" | "sub"; s: string }
  | { k: "role"; role: string; name?: Matcher; exact: boolean; level?: number; checked?: boolean | "mixed"; pressed?: boolean | "mixed"; expanded?: boolean; selected?: boolean; includeHidden?: boolean }
  | { k: "text" | "label" | "placeholder"; m: Matcher; exact: boolean }
  | { k: "testid"; m: Matcher }
  | { k: "nth"; i: number }
  | { k: "hasText"; m: Matcher; not?: boolean; exact?: boolean; deep?: boolean };

/** getByRole 의 선택. */
export interface RoleOpts {
  name?: string | RegExp;
  exact?: boolean;
  level?: number;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  includeHidden?: boolean;
}

export type WaitState = "visible" | "hidden" | "attached" | "detached";

/** 동작마다 줄 수 있는 선택: 대상이 나타나 동작할 수 있게 되길 기다리는 최대 시간(ms, 기본 10000, 0 이면 호출 한도까지). */
export interface ActOpts {
  timeout?: number;
}
/** 동작 전에 기다릴 조건: 보여야 하나 · 활성이어야 하나, 그리고 시간 초과 글에 쓸 「…할 수 있는」 꼴. */
export interface WaitCond {
  visible: boolean;
  enabled: boolean;
  phrase: string;
}
/** 동작이 대상이 나타나길 기다리는 기본 시간. 도구 호출 한도(120초)보다 훨씬 짧게 둔다. */
export const DEFAULT_ACTION_WAIT_MS = 10000;
/** 어떤 기다림도 이보다 길 수 없다(호출 한도 120초 안에 끝나도록). */
export const MAX_WAIT_MS = 110_000;
/** timeout 값을 하나로 바로잡는다: 안 줬으면 기본값, 0 보다 큰 수면 MAX_WAIT_MS 까지, 0 · NaN · 음수 · 숫자가 아니면 MAX_WAIT_MS(끝없이 기다리지 않는다). */
export function normTimeout(t: unknown, dflt: number): number {
  if (t === undefined || t === null) return Math.min(dflt, MAX_WAIT_MS);
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WAIT_MS) : MAX_WAIT_MS;
}

export interface Locator {
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  count(): Promise<number>;
  all(): Promise<Locator[]>;
  locator(selector: string): Locator;
  filter(opts: { hasText?: string | RegExp; hasNotText?: string | RegExp }): Locator;
  getByRole(role: string, opts?: RoleOpts): Locator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByTestId(id: string | RegExp): Locator;
  click(o?: ActOpts): Promise<void>;
  fill(value: string, o?: ActOpts): Promise<void>;
  textContent(o?: ActOpts): Promise<string>;
  innerText(o?: ActOpts): Promise<string>;
  inputValue(o?: ActOpts): Promise<string>;
  getAttribute(name: string, o?: ActOpts): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  check(o?: ActOpts): Promise<void>;
  uncheck(o?: ActOpts): Promise<void>;
  selectOption(value: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }>, o?: ActOpts): Promise<string[]>;
  press(key: string, o?: ActOpts): Promise<void>;
  type(text: string, o?: ActOpts): Promise<void>;
  pressSequentially(text: string, o?: ActOpts): Promise<void>;
  hover(o?: ActOpts): Promise<void>;
  focus(o?: ActOpts): Promise<void>;
  scrollIntoViewIfNeeded(o?: ActOpts): Promise<void>;
  waitFor(opts?: { state?: WaitState; timeout?: number }): Promise<void>;
}

/** Page 가 Locator 에게 해 주는 일. act 는 이동할 수 있는 동작(settleTab 으로 확인), read 는 읽기만(확인 없음). */
export interface LocatorHost {
  act(op: ActionOp, args: Record<string, unknown>): Promise<ActionOk["r"]>;
  read(op: ActionOp, args: Record<string, unknown>): Promise<ActionOk["r"]>;
  waitState(chain: Step[], desc: string, state: WaitState, timeout: number | undefined): Promise<void>;
  /** 조건(cond)이 될 때까지 다시 시도하며 동작 · 읽기 하나를 한다(시도 하나 = runJs 하나). */
  until(kind: "act" | "read", op: ActionOp, args: Record<string, unknown>, cond: WaitCond, desc: string, timeout: number | undefined): Promise<ActionOk["r"]>;
}

// ---- 값 바꾸기 · 글 만들기 ----

/** sandbox(vm) 안에서 만든 RegExp 는 이 쪽 RegExp 의 instanceof 가 아니므로 꼬리표로 알아본다. */
export const isRegExp = (x: unknown): x is RegExp => Object.prototype.toString.call(x) === "[object RegExp]";

export function toMatcher(x: string | RegExp): Matcher {
  return isRegExp(x) ? { re: x.source, fl: x.flags } : { s: String(x) };
}

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const showMatcher = (m: Matcher) => ("re" in m ? `/${m.re}/${m.fl}` : quote(m.s));

/** 오류 글에 쓰는 Playwright 꼴 설명: `getByRole('button', {name: '보내기'}).first()`. */
export function describeChain(chain: Step[]): string {
  return chain
    .map((st) => {
      switch (st.k) {
        case "css":
        case "ref":
        case "sub":
          return `locator(${quote(st.s)})`;
        case "role": {
          const o = [
            st.name ? `name: ${showMatcher(st.name)}` : "",
            st.exact ? "exact: true" : "",
            ...(["level", "checked", "pressed", "expanded", "selected", "includeHidden"] as const).filter((k) => st[k] !== undefined).map((k) => `${k}: ${JSON.stringify(st[k])}`),
          ].filter(Boolean).join(", ");
          return `getByRole(${quote(st.role)}${o ? `, {${o}}` : ""})`;
        }
        case "text":
        case "label":
        case "placeholder": {
          const fn = { text: "getByText", label: "getByLabel", placeholder: "getByPlaceholder" }[st.k];
          return `${fn}(${showMatcher(st.m)}${st.exact ? ", {exact: true}" : ""})`;
        }
        case "testid":
          return `getByTestId(${showMatcher(st.m)})`;
        case "nth":
          return st.i === 0 ? "first()" : st.i === -1 ? "last()" : `nth(${st.i})`;
        case "hasText":
          return `filter({${st.not ? "hasNotText" : "hasText"}: ${showMatcher(st.m)}})`;
      }
    })
    .join(".");
}

const noXpath = () => new Error("xpath 선택자는 지원하지 않아요 — getByRole · getByText 나 CSS 선택자로 바꿔 쓰세요");

/** 따옴표 · 괄호 · 대괄호 밖에 있는 `>>` 로 선택자를 나눈다. */
function splitChain(sel: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let q = "";
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]!;
    if (q) {
      cur += c;
      if (c === "\\" && i + 1 < sel.length) cur += sel[++i]!;
      else if (c === q) q = "";
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === "[" || c === "(") {
      depth++;
      cur += c;
    } else if (c === "]" || c === ")") {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (c === ">" && sel[i + 1] === ">" && depth === 0) {
      parts.push(cur);
      cur = "";
      i++;
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/** 따옴표로 싼 글 하나(`"…"` · `'…'`, 뒤의 \\ 이스케이프 풀기)를 읽는다. 따옴표로 시작하지 않으면 null. */
function readQuoted(s: string, at: number): { value: string; end: number } | null {
  const q = s[at];
  if (q !== '"' && q !== "'") return null;
  let v = "";
  for (let i = at + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) v += s[++i]!;
    else if (c === q) return { value: v, end: i + 1 };
    else v += c;
  }
  throw new Error(`선택자의 따옴표가 닫히지 않았어요: ${s}`);
}

/** `/정규식/플래그` 꼴이면 Matcher. 아니면 null. */
function readRegex(s: string): { re: string; fl: string } | null {
  const m = /^\/((?:[^/\\]|\\.)+)\/([a-z]*)$/s.exec(s);
  return m ? { re: m[1]!, fl: m[2]! } : null;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 글 값 하나: `/정규식/i` 는 정규식, 따옴표로 싸면 exact(`"글"i` 는 대소문자 무시 exact, `"글"s` 는 구분), 아니면 부분 일치.
 */
function textValue(raw: string): { m: Matcher; exact: boolean } {
  const v = raw.trim();
  const re = readRegex(v);
  if (re) return { m: re, exact: false };
  const q = readQuoted(v, 0);
  if (q) {
    const flag = v.slice(q.end).trim();
    if (flag === "") return { m: { s: q.value }, exact: true };
    if (flag === "s") return { m: { s: q.value }, exact: true };
    if (flag === "i") return { m: { re: `^\\s*${escapeRe(q.value.trim()).replace(/\s+/g, "\\s+")}\\s*$`, fl: "i" }, exact: false };
  }
  return { m: { s: v }, exact: false };
}

/** `id=`/`data-testid=` 의 값: 따옴표로 싸면 벗긴다. */
function plainValue(raw: string): string {
  const v = raw.trim();
  const q = readQuoted(v, 0);
  return q && q.end === v.length ? q.value : v;
}

const ROLE_BOOLS = ["checked", "pressed", "expanded", "selected"] as const;

function parseRoleEngine(body: string): Step {
  const head = /^\s*([a-zA-Z][\w-]*)\s*/.exec(body);
  if (!head) throw new Error(`role= 선택자 꼴이 잘못됐어요: role=${body} (예: role=button[name="저장"])`);
  const opts: Record<string, unknown> = {};
  let rest = body.slice(head[0].length);
  while (rest.length) {
    const m = /^\[\s*([a-zA-Z][\w-]*)\s*(?:=\s*)?/.exec(rest);
    if (!m) throw new Error(`role= 선택자 꼴이 잘못됐어요: role=${body}`);
    const key = m[1]!;
    let after = rest.slice(m[0].length);
    let value: string | null = null;
    let flag = "";
    if (m[0].includes("=")) {
      const q = readQuoted(after, 0);
      if (q) {
        value = q.value;
        after = after.slice(q.end);
        const f = /^\s*([is])\s*(?=\])/.exec(after);
        if (f) {
          flag = f[1]!;
          after = after.slice(f[0].length);
        }
        opts["__quoted_" + key] = true;
      } else {
        const end = after.indexOf("]");
        if (end < 0) throw new Error(`role= 선택자의 ]가 빠졌어요: role=${body}`);
        value = after.slice(0, end).trim();
        after = after.slice(end);
      }
    }
    if (!after.startsWith("]")) throw new Error(`role= 선택자의 ]가 빠졌어요: role=${body}`);
    rest = after.slice(1).trimStart();
    if (key === "name") {
      if (value === null) throw new Error("role= 선택자의 name 에는 값이 필요해요: [name=\"저장\"]");
      const re = opts["__quoted_name"] ? null : readRegex(value);
      opts.name = re ? new RegExp(re.re, re.fl) : value;
      if (flag === "s") opts.exact = true;
    } else if (key === "level") {
      if (value === null || !/^\d+$/.test(value)) throw new Error(`role= 선택자의 level 은 정수여야 해요: ${value ?? "(값 없음)"}`);
      opts.level = Number(value);
    }
    else if ((ROLE_BOOLS as readonly string[]).includes(key)) {
      const ok = key === "checked" || key === "pressed" ? ["true", "false", "mixed"] : ["true", "false"];
      if (value !== null && !ok.includes(value)) throw new Error(`role= 선택자의 ${key} 값이 잘못됐어요: ${value} (${ok.join(" · ")} 중 하나)`);
      opts[key] = value === null || value === "true" ? true : value === "false" ? false : "mixed";
    }
    else if (key === "include-hidden") opts.includeHidden = value === null || value === "true";
    else throw new Error(`role= 선택자가 모르는 속성이에요: ${key} (name · level · checked · pressed · expanded · selected · include-hidden 만 돼요)`);
  }
  for (const k of Object.keys(opts)) if (k.startsWith("__quoted_")) delete opts[k];
  return roleStep(head[1]!, opts as RoleOpts);
}

/** 따옴표 밖에서 처음 나오는 `:has-text(` · `:text(` · `:text-is(` 의 자리(없으면 -1). `[data-x="a:text(b)"]` 같은 속성 값 안은 건너뛴다. */
function findTextPseudo(part: string): number {
  let q = "";
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ":" && part[i - 1] !== ":" && /^:(has-text|text-is|text)\(/.test(part.slice(i))) return i;
  }
  return -1;
}

/**
 * CSS 선택자 끝의 `:has-text("글")` · `:text("글")` · `:text-is("글")` 을 떼어 hasText 단계로 바꾼다(끝에서만 쓸 수 있다).
 * `:text` · `:text-is` 는 맞는 가장 깊은(작은) 요소만 고르고(`div:text("x")` = 그 글을 가진 가장 깊은 div), 앞에 선택자가 없는 `:has-text("x")` 도 같다 — html · body 를 고르지 않게.
 * 앞에 선택자가 있는 `:has-text` 는 Playwright 처럼 그 글을 품은 모든 해당 요소다.
 */
function parseCss(part: string, kind: "css" | "sub"): Step[] {
  const at0 = findTextPseudo(part);
  const base = (at0 >= 0 ? part.slice(0, at0) : part).trim();
  const steps: Step[] = [{ k: kind, s: base || "*" }];
  if (at0 < 0) return steps;
  let at = at0;
  while (at < part.length) {
    const m = /^:(has-text|text-is|text)\(\s*/.exec(part.slice(at));
    if (!m) throw new Error(`:has-text · :text 는 선택자 끝에서만 쓸 수 있어요 — >> 로 나눠 쓰세요: ${part}`);
    let i = at + m[0].length;
    const q = readQuoted(part, i);
    let raw: string;
    if (q) {
      raw = JSON.stringify(q.value);
      i = q.end;
    } else {
      const end = part.indexOf(")", i);
      if (end < 0) throw new Error(`선택자의 )가 빠졌어요: ${part}`);
      raw = part.slice(i, end).trim();
      i = end;
    }
    const tail = /^\s*\)/.exec(part.slice(i));
    if (!tail) throw new Error(`선택자의 )가 빠졌어요: ${part}`);
    at = i + tail[0].length;
    const re2 = q ? null : readRegex(raw);
    const mm: Matcher = re2 ?? { s: q ? q.value : raw };
    const step: Step = { k: "hasText", m: mm, exact: m[1] === "text-is" };
    if (m[1] !== "has-text" || base === "") step.deep = true;
    steps.push(step);
  }
  return steps;
}

/**
 * 선택자 글을 단계 목록으로. `>>` 로 이어 좁히고, 조각마다 이런 꼴이 된다:
 * `e12`(ref) · `css=…` · `text=글`(따옴표면 exact, `/정규식/i` 도 됨) · `role=button[name="저장"][level=2]` · `id=x` · `data-testid=x` · `nth=0` · CSS 선택자(끝에 `:has-text("글")` 가능).
 * first 가 true 면 첫 조각을 문서 전체에서 찾고, 아니면 앞 결과의 안쪽에서 찾는다(둘의 차이는 설명 글뿐이다).
 */
export function parseSelector(sel: string, first = true): Step[] {
  const out: Step[] = [];
  splitChain(String(sel)).forEach((raw, idx) => {
    const part = raw.trim();
    if (!part) throw new Error(`선택자에 빈 조각이 있어요: ${sel}`);
    const kind: "css" | "sub" = first && idx === 0 ? "css" : "sub";
    if (/^e\d+$/.test(part)) return void out.push({ k: "ref", s: part });
    if (part.startsWith("//") || part.startsWith("..")) throw noXpath();
    const eng = /^([a-z][a-z0-9-]*)=(.*)$/s.exec(part);
    const name = eng?.[1];
    if (eng && name === "xpath") throw noXpath();
    if (eng && name === "css") return void out.push(...parseCss(eng[2]!.trim(), kind));
    if (eng && name === "text") {
      const t = textValue(eng[2]!);
      return void out.push({ k: "text", m: t.m, exact: t.exact });
    }
    if (eng && name === "role") return void out.push(parseRoleEngine(eng[2]!));
    if (eng && name === "nth") {
      const i = Number(eng[2]!.trim());
      if (!Number.isInteger(i)) throw new Error(`nth= 에는 정수가 필요해요: ${part}`);
      return void out.push({ k: "nth", i });
    }
    if (eng && name === "id") return void out.push({ k: kind, s: `[id=${JSON.stringify(plainValue(eng[2]!))}]` });
    if (eng && (name === "data-testid" || name === "testid")) return void out.push({ k: "testid", m: { s: plainValue(eng[2]!) } });
    out.push(...parseCss(part, kind));
  });
  return out;
}

const KNOWN_ROLE_KEYS = ["name", "exact", "level", "checked", "pressed", "expanded", "selected", "includeHidden"];

/** getByRole(role, opts) 의 단계. 모르는 옵션은 조용히 넘기지 않고 오류로 알린다. */
export function roleStep(role: string, opts: RoleOpts = {}): Step {
  const o = (opts ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN_ROLE_KEYS.includes(k) && o[k] !== undefined);
  if (unknown.length) throw new Error(`getByRole 이 모르는 옵션이에요: ${unknown.join(", ")} (name · exact · level · checked · pressed · expanded · selected · includeHidden 만 돼요)`);
  if (o.level !== undefined && !Number.isInteger(Number(o.level))) throw new Error("getByRole 의 level 은 정수여야 해요");
  const step: Extract<Step, { k: "role" }> = { k: "role", role: String(role).toLowerCase(), name: o.name === undefined ? undefined : toMatcher(o.name as string | RegExp), exact: !!o.exact };
  if (o.level !== undefined) step.level = Number(o.level);
  for (const k of ["checked", "pressed"] as const) if (o[k] !== undefined) step[k] = o[k] === "mixed" ? "mixed" : !!o[k];
  for (const k of ["expanded", "selected", "includeHidden"] as const) if (o[k] !== undefined) step[k] = !!o[k];
  return step;
}

/** getByText · getByLabel · getByPlaceholder 의 단계(옵션은 exact 만). */
export function textStep(fn: string, k: "text" | "label" | "placeholder", text: string | RegExp, opts: { exact?: boolean } = {}): Step {
  const unknown = Object.keys(opts ?? {}).filter((x) => x !== "exact" && (opts as Record<string, unknown>)[x] !== undefined);
  if (unknown.length) throw new Error(`${fn} 이 모르는 옵션이에요: ${unknown.join(", ")} (exact 만 돼요)`);
  return { k, m: toMatcher(text), exact: !!opts?.exact };
}

/**
 * Playwright 의 글 패턴: `*` 는 `/` 를 뺀 아무 글, `**` 는 `/` 까지 아무 글, `?` 는 한 글자, `{a,b}` 는 둘 중 하나. 나머지는 글자 그대로. 처음부터 끝까지 맞아야 한다.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          // `**/` 는 맨 앞이나 `/` 뒤에서는 「디렉터리 0개 이상」, 그 밖에서는 「…/」
          re += i - 1 === 0 || glob[i - 2] === "/" ? "(?:.*/)?" : "(?:.*/)";
          i++;
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace = true;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

type SelectSpec = string | { value?: string; label?: string; index?: number };

// ---- 구현 ----

export class LocatorImpl implements Locator {
  constructor(
    private readonly host: LocatorHost,
    private readonly chain: Step[],
  ) {}

  /** console.log(locator) 가 안쪽까지 쏟아내지 않게. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Locator { ${describeChain(this.chain)} }`;
  }

  private next(step: Step): LocatorImpl {
    return new LocatorImpl(this.host, [...this.chain, step]);
  }
  private args(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { chain: this.chain, desc: describeChain(this.chain), ...extra };
  }

  first = () => this.next({ k: "nth", i: 0 });
  last = () => this.next({ k: "nth", i: -1 });
  nth = (index: number) => {
    const i = Math.trunc(Number(index));
    if (!Number.isFinite(i)) throw new Error("nth(i): i 는 정수여야 합니다");
    return this.next({ k: "nth", i });
  };
  locator = (selector: string) => new LocatorImpl(this.host, [...this.chain, ...parseSelector(selector, false)]);
  filter = (opts: { hasText?: string | RegExp; hasNotText?: string | RegExp }) => {
    const o = (opts ?? {}) as Record<string, unknown>;
    for (const k of ["has", "hasNot"]) {
      if (o[k] !== undefined) throw new Error(`filter 의 ${k} 는 아직 지원하지 않아요 — locator(하위 선택자) 나 getBy… 로 좁혀 보세요`);
    }
    const unknown = Object.keys(o).filter((k) => k !== "hasText" && k !== "hasNotText" && o[k] !== undefined);
    if (unknown.length) throw new Error(`filter 가 모르는 옵션이에요: ${unknown.join(", ")} (hasText · hasNotText 만 돼요)`);
    if (o.hasText === undefined && o.hasNotText === undefined) throw new Error("filter({hasText}) 나 filter({hasNotText}) 가 필요해요");
    const steps: Step[] = [];
    if (o.hasText !== undefined) steps.push({ k: "hasText", m: toMatcher(o.hasText as string | RegExp) });
    if (o.hasNotText !== undefined) steps.push({ k: "hasText", m: toMatcher(o.hasNotText as string | RegExp), not: true });
    return new LocatorImpl(this.host, [...this.chain, ...steps]);
  };
  getByRole = (role: string, opts: RoleOpts = {}) => this.next(roleStep(role, opts));
  getByText = (text: string | RegExp, opts: { exact?: boolean } = {}) => this.next(textStep("getByText", "text", text, opts));
  getByLabel = (text: string | RegExp, opts: { exact?: boolean } = {}) => this.next(textStep("getByLabel", "label", text, opts));
  getByPlaceholder = (text: string | RegExp, opts: { exact?: boolean } = {}) => this.next(textStep("getByPlaceholder", "placeholder", text, opts));
  getByTestId = (id: string | RegExp) => this.next({ k: "testid", m: toMatcher(id) });

  async count(): Promise<number> {
    return Number((await this.host.read("count", this.args())).v ?? 0);
  }
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  /** 대상이 준비될 때까지 기다리며 동작 · 읽기 하나를 한다. */
  private wait(kind: "act" | "read", op: ActionOp, extra: Record<string, unknown>, o: ActOpts | undefined, cond: Partial<WaitCond> & { phrase: string }) {
    const args = this.args(extra);
    return this.host.until(kind, op, args, { visible: cond.visible ?? true, enabled: cond.enabled ?? false, phrase: cond.phrase }, args.desc as string, o?.timeout);
  }

  async click(o?: ActOpts): Promise<void> {
    await this.wait("act", "click", {}, o, { enabled: true, phrase: "누를 수 있는" });
  }
  async fill(value: string, o?: ActOpts): Promise<void> {
    await this.wait("act", "fill", { value: String(value) }, o, { enabled: true, phrase: "글을 채울 수 있는" });
  }
  // 읽기는 「붙어 있기만」 하면 된다(Playwright 처럼 — 안 보이는 meta · script · 숨은 칸의 값도 읽는다).
  async textContent(o?: ActOpts): Promise<string> {
    return (await this.wait("read", "text", {}, o, { visible: false, phrase: "있는" })).text ?? "";
  }
  async innerText(o?: ActOpts): Promise<string> {
    return String((await this.wait("read", "prop", { what: "innerText" }, o, { visible: false, phrase: "있는" })).v ?? "");
  }
  async inputValue(o?: ActOpts): Promise<string> {
    return String((await this.wait("read", "prop", { what: "inputValue" }, o, { visible: false, phrase: "있는" })).v ?? "");
  }
  async getAttribute(name: string, o?: ActOpts): Promise<string | null> {
    const v = (await this.wait("read", "prop", { what: "attr", name: String(name) }, o, { visible: false, phrase: "있는" })).v;
    return v === undefined || v === null ? null : String(v);
  }
  // 아래 셋은 기다리지 않는다(Playwright 처럼): 없으면 isVisible 은 false, 나머지는 바로 오류.
  async isVisible(): Promise<boolean> {
    return (await this.host.read("prop", this.args({ what: "isVisible" }))).v === true;
  }
  async isChecked(): Promise<boolean> {
    return (await this.host.read("prop", this.args({ what: "isChecked" }))).v === true;
  }
  async isEnabled(): Promise<boolean> {
    return (await this.host.read("prop", this.args({ what: "isEnabled" }))).v === true;
  }
  async check(o?: ActOpts): Promise<void> {
    await this.wait("act", "check", { want: true }, o, { enabled: true, phrase: "켤 수 있는" });
  }
  async uncheck(o?: ActOpts): Promise<void> {
    await this.wait("act", "check", { want: false }, o, { enabled: true, phrase: "끌 수 있는" });
  }
  async selectOption(value: SelectSpec | SelectSpec[], o?: ActOpts): Promise<string[]> {
    const list = Array.isArray(value) ? value : [value];
    const sel = list.map((x) => (typeof x === "string" ? { any: x } : { value: x?.value, label: x?.label, index: x?.index }));
    const r = await this.wait("act", "select", { sel }, o, { enabled: true, phrase: "고를 수 있는" });
    return Array.isArray(r.v) ? (r.v as string[]) : [];
  }
  async press(key: string, o?: ActOpts): Promise<void> {
    await this.wait("act", "lpress", { key: String(key) }, o, { phrase: "글쇠를 받을 수 있는" });
  }
  async type(text: string, o?: ActOpts): Promise<void> {
    await this.wait("act", "ltype", { text: String(text) }, o, { enabled: true, phrase: "글을 쳐 넣을 수 있는" });
  }
  pressSequentially = (text: string, o?: ActOpts) => this.type(text, o);
  async hover(o?: ActOpts): Promise<void> {
    await this.wait("act", "hover", {}, o, { phrase: "올릴 수 있는" });
  }
  async focus(o?: ActOpts): Promise<void> {
    await this.wait("act", "focus", {}, o, { phrase: "초점을 줄 수 있는" });
  }
  async scrollIntoViewIfNeeded(o?: ActOpts): Promise<void> {
    await this.wait("act", "scroll", {}, o, { phrase: "보이는" });
  }
  async waitFor(opts: { state?: WaitState; timeout?: number } = {}): Promise<void> {
    const state = opts?.state ?? "visible";
    if (!["visible", "hidden", "attached", "detached"].includes(state)) throw new Error(`waitFor({state}): state 는 visible · hidden · attached · detached 중 하나여야 합니다 (받은 값: ${state})`);
    await this.host.waitState(this.chain, describeChain(this.chain), state, opts?.timeout);
  }
}
