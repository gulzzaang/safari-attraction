/**
 * 동작 관문. 사파리 앱(옆 창)이 환경값으로 유닉스 소켓 경로를 알려 주면, 페이지를 바꾸는 동작 직전에 그 소켓으로 한 줄 JSON 을 보내
 * 허락을 묻는다. 환경값이 없으면 관문은 null 이고 아무것도 묻지 않는다(Claude Code 등 기존 사용은 지금과 똑같다).
 *
 * 요청 한 줄: {"v":1,"token":"…","id":"<무작위>","host","url","action","target","value","irreversible"} → 답 한 줄: {"id","allow":true|false,"reason"?}.
 * 연결 실패 · 끊김 · 시간 초과 · 깨진 답은 모두 거절이다(던지지 않는다).
 */

import { randomBytes } from "node:crypto";
import net from "node:net";
import { SafariError } from "../driver/types.js";
import { isIrreversibleText } from "./classify.js";

export type GateAction = "click" | "fill" | "check" | "uncheck" | "select" | "press" | "type" | "evaluate" | "fetch" | "goto" | "nav";

/** 관문에 묻는 내용(토큰 · id 는 손님이 붙인다). */
export type GateRequest = {
  /** 동작이 일어나는 사이트의 호스트(goto 는 가려는 곳). 모르면 빈 글. */
  host: string;
  url: string;
  action: GateAction;
  /** 동작 대상(버튼 글 · 식 앞 120자 · 주소), 120자까지. */
  target: string;
  /** 넣는 값, 40자까지. 비밀번호 칸이면 「(비밀)」. 없으면 빈 글. */
  value: string;
  /** 되돌릴 수 없는 동작이면 true, 아니면 false, 알 수 없으면(evaluate) null. */
  irreversible: boolean | null;
};

export type GateAnswer = { allow: boolean; reason?: string };

export interface ActionGate {
  check(req: GateRequest): Promise<GateAnswer>;
}

/**
 * 답을 기다리는 한도. 앱은 자기 한도 300초에 거절을 먼저 돌려주므로 서버는 그보다 조금 더(310초) 기다린다 — 앱의 답이 먼저 오도록.
 */
export const GATE_WAIT_LIMIT_MS = 310_000;

const TARGET_MAX = 120;
const VALUE_MAX = 40;
export const SECRET_VALUE = "(비밀)";

/** 글을 n 자(코드 포인트)까지로 자른다. */
export const clip = (s: unknown, n: number): string => Array.from(String(s ?? "")).slice(0, n).join("");
export const clipTarget = (s: unknown): string => clip(s, TARGET_MAX);
export const clipValue = (s: unknown): string => clip(s, VALUE_MAX);

/** 주소의 호스트(주소가 아니면 빈 글). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * 이 주소로 가는 일이 「웹 이동」이 아닌가 — 주소로 읽히는데 http: · https: · about:blank 가 아니면(javascript: · data: · file: · blob: …) true.
 * 그런 주소는 이동이 아니라 코드 실행 · 파일 열기일 수 있어 관문이 evaluate(알 수 없음)로 묻는다. 주소로 못 읽는 글은 false(상대 주소 등).
 */
export function isNonWebDestination(url: string): boolean {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return false;
  }
  if (u.protocol === "http:" || u.protocol === "https:") return false;
  return u.href !== "about:blank";
}

/** SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS=1 이면 맥 허락 창이 뜰 수 있는 일(화면 기록 등)을 미리 확인하고 안 한다. */
export function noPermissionPromptsFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS === "1";
}

const deny = (reason: string): GateAnswer => ({ allow: false, reason });

/** 소켓 하나로 요청 하나를 보내고 답 하나를 받는다. 무슨 일이 있어도 던지지 않고 resolve 한다. */
function ask(path: string, token: string, req: GateRequest, limitMs: number): Promise<GateAnswer> {
  return new Promise((resolve) => {
    const id = randomBytes(8).toString("hex");
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sock = net.createConnection(path);
    const finish = (a: GateAnswer) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sock.destroy();
      resolve(a);
    };
    timer = setTimeout(() => finish(deny("답이 없어 거절했어요")), limitMs);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ v: 1, token, id, ...req }) + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ans: { id?: unknown; allow?: unknown; reason?: unknown };
        try {
          ans = JSON.parse(line);
        } catch {
          return finish(deny("관문의 답을 읽지 못해 거절했어요"));
        }
        if (!ans || typeof ans !== "object" || ans.id !== id) continue; // 다른 요청의 답은 무시
        if (ans.allow === true) return finish({ allow: true });
        return finish(deny(typeof ans.reason === "string" && ans.reason ? ans.reason : "허락하지 않았어요"));
      }
    });
    sock.on("error", () => finish(deny("관문에 연결하지 못해 거절했어요")));
    sock.on("close", () => finish(deny("관문과 연결이 끊겨 거절했어요")));
  });
}

/**
 * 환경값으로 관문 손님을 만든다. SAFARI_ATTRACTION_GATE(소켓 경로)가 없으면 null.
 * 토큰(SAFARI_ATTRACTION_GATE_TOKEN)은 요청마다 붙인다. 시험에서는 두 번째 인자로 기다림 한도를 바꾼다.
 */
export function createGateFromEnv(env: NodeJS.ProcessEnv, opts: { limitMs?: number } = {}): ActionGate | null {
  const path = env.SAFARI_ATTRACTION_GATE;
  if (!path) return null;
  const token = env.SAFARI_ATTRACTION_GATE_TOKEN ?? "";
  const limitMs = opts.limitMs ?? GATE_WAIT_LIMIT_MS;
  return { check: (req) => ask(path, token, req, limitMs) };
}

/** 거절 답을 오류로 바꿔 던진다(허락이면 아무 일 없다). */
export function assertAllowed(a: GateAnswer): void {
  if (!a.allow) throw new SafariError("ACTION_DENIED", `사용자가 거절했어요: ${a.reason ?? "허락하지 않았어요"}`);
}

/** in-page 의 desc 읽기가 돌려주는 요소 설명. */
export interface ElementDesc {
  text?: string;
  aria?: string;
  value?: string;
  inputType?: string;
  /** 비밀 칸(type=password 이거나 autocomplete 가 비밀번호 · 일회용 코드 · 카드 정보) — 값은 읽지도 보내지도 않는다. */
  isPassword?: boolean;
  formSubmitText?: string;
  /** 글 · 이름표가 다 비었을 때 보여 줄 거친 설명(태그 · name · id · placeholder). */
  hint?: string;
}

/** 줄바꿈(Enter)을 뜻하는 글쇠 · 글인가. */
const isEnterKey = (k: unknown): boolean => /^(enter|return)$/i.test(String(k ?? "").trim());

/**
 * 동작 하나의 관문 요청 내용을 만든다. desc 는 동작할 요소(chain 이 없으면 초점 요소)의 설명.
 * 되돌릴 수 없음: 요소 글(text · aria)이 그런 낱말이거나, Enter(줄바꿈 포함)이고 폼 제출 단추 글이 그런 낱말일 때.
 */
export function buildElementRequest(
  op: string,
  args: Record<string, unknown>,
  desc: ElementDesc | undefined,
): Pick<GateRequest, "action" | "target" | "value" | "irreversible"> {
  const d = desc ?? {};
  const label = (d.text && d.text.trim()) || (d.aria && d.aria.trim()) || d.hint || "";
  const secret = d.isPassword === true;
  let action: GateAction;
  let value = "";
  let enter = false;
  switch (op) {
    case "click":
      action = "click";
      break;
    case "fill":
      action = "fill";
      value = secret ? SECRET_VALUE : clipValue(args.value);
      break;
    case "check":
      action = args.want === false ? "uncheck" : "check";
      break;
    case "select": {
      action = "select";
      const sel = Array.isArray(args.sel) ? (args.sel as Array<Record<string, unknown>>) : [];
      value = clipValue(sel.map((x) => x.any ?? x.value ?? x.label ?? (x.index !== undefined ? `#${x.index}` : "")).join(", "));
      break;
    }
    case "lpress":
    case "press":
      action = "press";
      enter = isEnterKey(args.key);
      value = secret && String(args.key ?? "").length === 1 ? SECRET_VALUE : clipValue(args.key);
      break;
    case "ltype":
    case "type":
      action = "type";
      enter = String(args.text ?? "").includes("\n");
      value = secret ? SECRET_VALUE : clipValue(args.text);
      break;
    default:
      throw new Error(`관문이 모르는 동작: ${op}`);
  }
  const irreversible = isIrreversibleText(d.text) || isIrreversibleText(d.aria) || (enter && isIrreversibleText(d.formSubmitText));
  return { action, target: clipTarget(label), value, irreversible };
}
