/**
 * 동작 관문이 쓰는 판정 둘.
 *  - 글(버튼 · 제출 단추 이름)이 되돌릴 수 없는 일을 뜻하나(isIrreversibleText)
 *  - evaluate 식이 페이지를 바꾸지 않는 읽기 전용인가(isReadOnlyExpression)
 * 둘 다 「실수 · 보통의 속임」을 막으려는 것이고, 일부러 빠져나가는 코드까지 막는 벽은 아니다.
 */

import { parse } from "acorn";

/** 되돌릴 수 없는 일을 뜻하는 낱말(대소문자 무시). */
const IRREVERSIBLE_RE = /결제|구매|주문|보내기|전송|송금|이체|삭제|지우기|탈퇴|해지|확정|제출|신청|예약|pay|buy|order|purchase|checkout|send|submit|delete|remove|transfer|confirm|book/i;

export function isIrreversibleText(s: string | null | undefined): boolean {
  return typeof s === "string" && IRREVERSIBLE_RE.test(s);
}

/** 페이지 안 fetch 의 메서드가 읽기(GET · HEAD, 안 주면 GET)가 아니라 바꾸는 요청인가 — 그러면 관문이 묻고 되돌릴 수 없음으로 친다. */
export function fetchIsIrreversible(method: string | undefined | null): boolean {
  const m = String(method ?? "").trim().toUpperCase();
  return !(m === "" || m === "GET" || m === "HEAD");
}

/** 페이지를 바꾸는 메서드(호출하면 읽기 전용이 아니다). */
const MUTATING_METHODS = new Set([
  "click", "submit", "requestSubmit", "dispatchEvent", "setAttribute", "removeAttribute", "remove", "append", "appendChild", "prepend", "insertBefore",
  "replaceWith", "replaceChildren", "setItem", "removeItem", "clear", "pushState", "replaceState", "assign", "open", "write", "focus", "blur",
  "scrollTo", "scrollBy", "scrollIntoView", "play", "pause",
]);
/** 이름이 나오기만 해도(변수 · 속성) 읽기 전용이 아닌 것 — 네트워크 · 코드 만들기 · 생성자 우회. */
const FORBIDDEN_NAMES = new Set(["fetch", "XMLHttpRequest", "WebSocket", "sendBeacon", "eval", "Function", "constructor"]);

type Node = { type: string; [k: string]: any };

/** 패턴(대입 왼쪽 · 선언)에 들어 있는 이름들. 멤버 식이 섞여 있으면 member 를 true 로 알린다. */
function patternNames(p: Node | null, names: string[], flags: { member: boolean }): void {
  if (!p) return;
  switch (p.type) {
    case "Identifier":
      names.push(p.name);
      break;
    case "ObjectPattern":
      for (const prop of p.properties) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, names, flags);
      break;
    case "ArrayPattern":
      for (const el of p.elements) patternNames(el, names, flags);
      break;
    case "RestElement":
      patternNames(p.argument, names, flags);
      break;
    case "AssignmentPattern":
      patternNames(p.left, names, flags);
      break;
    default:
      flags.member = true; // MemberExpression 등
  }
}

const childNodes = (n: Node): Node[] => {
  const out: Node[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (k === "type" || k === "start" || k === "end") continue;
    if (Array.isArray(v)) for (const x of v) if (x && typeof x === "object" && typeof x.type === "string") out.push(x);
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Node).type === "string") out.push(v as Node);
  }
  return out;
};

/** 식 안에서 선언된 이름(매개변수 · var/let/const · 함수 · 클래스 · catch)을 모은다. */
function declaredNames(root: Node): Set<string> {
  const names: string[] = [];
  const flags = { member: false };
  const visit = (n: Node) => {
    switch (n.type) {
      case "VariableDeclarator":
        patternNames(n.id, names, flags);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (n.id) names.push(n.id.name);
        for (const p of n.params) patternNames(p, names, flags);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (n.id) names.push(n.id.name);
        break;
      case "CatchClause":
        patternNames(n.param, names, flags);
        break;
    }
    for (const c of childNodes(n)) visit(c);
  };
  visit(root);
  return new Set(names);
}

const propName = (m: Node): string | null => {
  if (!m.computed) return m.property.type === "Identifier" ? m.property.name : null; // #private 이름은 null
  return m.property.type === "Literal" && typeof m.property.value === "string" ? m.property.value : null;
};

/** 노드 하나(와 그 아래)가 읽기만 하나. */
function readOnlyNode(n: Node, locals: Set<string>): boolean {
  switch (n.type) {
    case "AssignmentExpression": {
      const names: string[] = [];
      const flags = { member: false };
      patternNames(n.left, names, flags);
      if (flags.member || names.some((x) => !locals.has(x))) return false;
      break;
    }
    case "UpdateExpression":
      return false; // ++ · --
    case "UnaryExpression":
      if (n.operator === "delete") return false;
      break;
    case "ImportExpression":
    case "WithStatement":
      return false;
    case "ForInStatement":
    case "ForOfStatement":
      if (n.left.type !== "VariableDeclaration") {
        const names: string[] = [];
        const flags = { member: false };
        patternNames(n.left, names, flags);
        if (flags.member || names.some((x) => !locals.has(x))) return false;
      }
      break;
    case "Identifier":
      if (FORBIDDEN_NAMES.has(n.name)) return false;
      break;
    case "MemberExpression": {
      const name = propName(n);
      if (name !== null && FORBIDDEN_NAMES.has(name)) return false;
      break;
    }
    case "CallExpression": {
      let callee: Node = n.callee;
      if (callee.type === "ChainExpression") callee = callee.expression;
      if (callee.type === "MemberExpression") {
        const name = propName(callee);
        if (name === null) return false; // el[name]() — 무슨 메서드인지 모른다
        if (MUTATING_METHODS.has(name)) return false;
      }
      break;
    }
  }
  for (const [k, v] of Object.entries(n)) {
    if (k === "type" || k === "start" || k === "end") continue;
    // 객체 글자값의 키(`{open: 1}`)와 점 뒤 이름(`a.open`)은 이름표일 뿐이라 따로(위의 MemberExpression · CallExpression)만 본다.
    if ((n.type === "MemberExpression" && k === "property" && !n.computed) || (n.type === "Property" && k === "key" && !n.computed) || (n.type === "MethodDefinition" && k === "key" && !n.computed) || (n.type === "PropertyDefinition" && k === "key" && !n.computed)) continue;
    const kids = Array.isArray(v) ? v : [v];
    for (const c of kids) if (c && typeof c === "object" && typeof (c as Node).type === "string" && !readOnlyNode(c as Node, locals)) return false;
  }
  return true;
};

/**
 * evaluate 에 넘긴 식(또는 함수) 소스가 페이지를 바꾸지 않는 읽기 전용인가. 대입(식 안에서 선언한 지역 변수 말고) · ++ · -- · delete ·
 * 바꾸는 메서드 호출 · fetch · XMLHttpRequest · WebSocket · sendBeacon · eval · Function 이 없으면 true. 못 읽으면(문법 이상 · 식을 빠져나가는 글) false.
 * 서버가 페이지에 실제로 보내는 꼴(`(function(){ return (식\n); })()`)과 똑같이 감싸 풀고, 그 틀을 벗어난 모양이면 false 다.
 */
export function isReadOnlyExpression(src: string): boolean {
  if (typeof src !== "string" || src.trim() === "") return false;
  let program: Node;
  try {
    program = parse(`(function(){ return (${src}\n); })()`, { ecmaVersion: "latest", sourceType: "script" }) as unknown as Node;
  } catch {
    return false;
  }
  // 틀 확인: 문장 하나 = 즉시 실행 함수, 그 안은 return 하나. 다르면 식이 틀을 빠져나간 것이다.
  const stmt = program.body.length === 1 ? (program.body[0] as Node) : null;
  const call = stmt && stmt.type === "ExpressionStatement" ? (stmt.expression as Node) : null;
  const fn = call && call.type === "CallExpression" && call.arguments.length === 0 ? (call.callee as Node) : null;
  const body = fn && fn.type === "FunctionExpression" && fn.params.length === 0 ? (fn.body as Node) : null;
  if (!body || body.body.length !== 1 || body.body[0].type !== "ReturnStatement" || !body.body[0].argument) return false;
  return readOnlyNode(program, declaredNames(program));
}
