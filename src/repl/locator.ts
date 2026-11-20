/**
 * Playwright 식 Locator. 찾는 방법은 「단계 목록(chain)」으로 들고 있다가, 동작할 때 통째로 페이지에 보내 거기서 찾고 바로 동작한다
 * (inpage-locator.ts). 엄격하지 않다 — 여러 개가 맞으면 동작은 화면에 보이는 첫 번째에 하고, count() · all() 은 전부를 본다.
 */

import type { ActionOk, ActionOp } from "./inpage-actions.js";

export type Matcher = { s: string } | { re: string; fl: string };

/** 찾기 단계 하나. 앞 단계의 결과 안(없으면 문서 전체)에서 이어서 좁힌다. */
export type Step =
  | { k: "css" | "ref" | "sub"; s: string }
  | { k: "role"; role: string; name?: Matcher; exact: boolean }
  | { k: "text" | "label" | "placeholder"; m: Matcher; exact: boolean }
  | { k: "testid"; m: Matcher }
  | { k: "nth"; i: number }
  | { k: "hasText"; m: Matcher };

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

export interface Locator {
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  count(): Promise<number>;
  all(): Promise<Locator[]>;
  locator(selector: string): Locator;
  filter(opts: { hasText: string | RegExp }): Locator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
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
  waitState(chain: Step[], desc: string, state: WaitState, timeoutMs: number): Promise<void>;
  /** 조건(cond)이 될 때까지 다시 시도하며 동작 · 읽기 하나를 한다(시도 하나 = runJs 하나). */
  until(kind: "act" | "read", op: ActionOp, args: Record<string, unknown>, cond: WaitCond, desc: string, timeoutMs: number): Promise<ActionOk["r"]>;
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
          const o = [st.name ? `name: ${showMatcher(st.name)}` : "", st.exact ? "exact: true" : ""].filter(Boolean).join(", ");
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
          return `filter({hasText: ${showMatcher(st.m)}})`;
      }
    })
    .join(".");
}

/** `locator(글)` 의 글을 단계로: `e12` 는 ref, `text=…` 는 글 찾기(따옴표로 싸면 정확히), 그 밖에는 CSS. */
export function parseSelector(sel: string): Step {
  const s = String(sel);
  if (/^e\d+$/.test(s)) return { k: "ref", s };
  const t = /^text=(.*)$/s.exec(s);
  if (t) {
    const q = /^(["'])(.*)\1$/s.exec(t[1]!);
    return q ? { k: "text", m: { s: q[2]! }, exact: true } : { k: "text", m: { s: t[1]! }, exact: false };
  }
  return { k: "css", s };
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
        re += ".*";
        i++;
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
  locator = (selector: string) => this.next({ k: "sub", s: String(selector) });
  filter = (opts: { hasText: string | RegExp }) => {
    if (opts?.hasText === undefined) throw new Error("filter({hasText}) 만 지원해요");
    return this.next({ k: "hasText", m: toMatcher(opts.hasText) });
  };
  getByRole = (role: string, opts: { name?: string | RegExp; exact?: boolean } = {}) =>
    this.next({ k: "role", role: String(role).toLowerCase(), name: opts?.name === undefined ? undefined : toMatcher(opts.name), exact: !!opts?.exact });
  getByText = (text: string | RegExp, opts: { exact?: boolean } = {}) => this.next({ k: "text", m: toMatcher(text), exact: !!opts?.exact });
  getByLabel = (text: string | RegExp, opts: { exact?: boolean } = {}) => this.next({ k: "label", m: toMatcher(text), exact: !!opts?.exact });
  getByPlaceholder = (text: string | RegExp, opts: { exact?: boolean } = {}) => this.next({ k: "placeholder", m: toMatcher(text), exact: !!opts?.exact });
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
    return this.host.until(kind, op, args, { visible: cond.visible ?? true, enabled: cond.enabled ?? false, phrase: cond.phrase }, args.desc as string, o?.timeout ?? DEFAULT_ACTION_WAIT_MS);
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
    await this.host.waitState(this.chain, describeChain(this.chain), state, opts?.timeout ?? 30000);
  }
}
