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

/**
 * 읽기용으로 알려진 메서드 이름 — 허락 목록이다. 이 밖의 메서드 호출은 무슨 일을 할지 모르므로 읽기 전용이 아니다
 * (페이지가 정의한 함수 · click · submit · .call/.apply/.bind · setTimeout · history.* · Object.assign 등).
 */
const READ_METHODS = new Set([
  "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName", "getElementsByTagName", "getElementsByName", "getAttribute", "getAttributeNames",
  "hasAttribute", "getBoundingClientRect", "getClientRects", "closest", "matches", "contains", "item", "namedItem", "getPropertyValue",
  "map", "filter", "reduce", "forEach", "find", "findIndex", "findLast", "some", "every", "includes", "indexOf", "lastIndexOf", "slice", "concat", "join", "flat", "flatMap",
  "keys", "values", "entries", "at", "sort", "reverse", "toString", "toLowerCase", "toUpperCase", "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll",
  "match", "matchAll", "test", "exec", "startsWith", "endsWith", "padStart", "padEnd", "substring", "substr", "charAt", "charCodeAt", "normalize", "localeCompare", "toFixed",
  "get", "has", "getAll",
]);
/** 읽기용 메서드라도 대상이 location 이면 주소를 바꾼다(location.replace). */
const LOCATION_UNSAFE_METHODS = new Set(["replace", "assign", "reload"]);
/** 부를 수 있는 전역 함수. */
const READ_GLOBAL_FUNCS = new Set([
  "Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "getComputedStyle", "getSelection",
]);
/** 부를 수 있는 정적 함수(객체 이름 → 함수 이름들, "*" 는 전부). */
const READ_STATIC_FUNCS: Record<string, ReadonlySet<string> | "*"> = {
  JSON: new Set(["stringify", "parse"]),
  Math: "*",
  Array: new Set(["from", "isArray", "of"]),
  Object: new Set(["keys", "values", "entries", "fromEntries"]),
  Date: new Set(["now"]),
  Number: new Set(["isNaN", "parseInt", "parseFloat"]),
};
/** `new` 로 만들 수 있는 것. */
const READ_NEW = new Set(["Set", "Map", "URL", "URLSearchParams", "Date", "RegExp", "Array", "Object"]);
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

interface Scope {
  /** 식 안에서 선언된 이름(매개변수 · var/let/const · 함수 · 클래스 · catch). */
  locals: Set<string>;
  /** 그중 함수로 선언돼 부를 수 있는 이름(식 안에서 다시 대입되는 이름은 뺀다). */
  fns: Set<string>;
}

/**
 * 식 안에서 선언된 이름을 모은다. 한계: 범위(scope)를 따지지 않고 식 전체에서 한 묶음으로 본다 — 안쪽 함수에서 선언한 이름과 같은 이름을
 * 바깥에서 대입하면 지역 변수 대입으로 잘못 볼 수 있다(일부러 속이는 코드까지는 막지 않는다).
 */
function scopeOf(root: Node): Scope {
  const names: string[] = [];
  const fnNames = new Set<string>();
  const assigned = new Set<string>();
  const flags = { member: false };
  const visit = (n: Node) => {
    switch (n.type) {
      case "VariableDeclarator":
        patternNames(n.id, names, flags);
        if (n.id.type === "Identifier" && n.init && (n.init.type === "FunctionExpression" || n.init.type === "ArrowFunctionExpression")) fnNames.add(n.id.name);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (n.id) {
          names.push(n.id.name);
          if (n.type === "FunctionDeclaration") fnNames.add(n.id.name);
        }
        for (const p of n.params) patternNames(p, names, flags);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (n.id) names.push(n.id.name);
        break;
      case "CatchClause":
        patternNames(n.param, names, flags);
        break;
      case "AssignmentExpression": {
        const t: string[] = [];
        patternNames(n.left, t, { member: false });
        for (const x of t) assigned.add(x);
        break;
      }
    }
    for (const c of childNodes(n)) visit(c);
  };
  visit(root);
  return { locals: new Set(names), fns: new Set([...fnNames].filter((x) => !assigned.has(x))) };
}

const propName = (m: Node): string | null => {
  if (!m.computed) return m.property.type === "Identifier" ? m.property.name : null; // #private 이름은 null
  return m.property.type === "Literal" && typeof m.property.value === "string" ? m.property.value : null;
};

/** location · window.location · document.location 처럼 보이는 대상인가. */
const isLocationObject = (o: Node): boolean => (o.type === "Identifier" && o.name === "location") || (o.type === "MemberExpression" && propName(o) === "location");

/** 부르는 것(callee)이 읽기 전용으로 알려진 것인가 — 허락 목록. */
function calleeAllowed(callee: Node, sc: Scope): boolean {
  let c = callee;
  if (c.type === "ChainExpression") c = c.expression;
  switch (c.type) {
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return true; // 즉시 실행 함수(몸통은 따로 훑는다)
    case "Identifier":
      return sc.fns.has(c.name) || (READ_GLOBAL_FUNCS.has(c.name) && !sc.locals.has(c.name));
    case "MemberExpression": {
      const name = propName(c);
      if (name === null) return false; // el[name]() — 무슨 메서드인지 모른다
      const obj: Node = c.object;
      if (obj.type === "Identifier" && !sc.locals.has(obj.name) && Object.prototype.hasOwnProperty.call(READ_STATIC_FUNCS, obj.name)) {
        const allowed = READ_STATIC_FUNCS[obj.name]!;
        if (allowed === "*" || allowed.has(name)) return true;
      }
      if (!READ_METHODS.has(name)) return false;
      if (LOCATION_UNSAFE_METHODS.has(name) && isLocationObject(obj)) return false;
      return true;
    }
    default:
      return false; // f()() · (a, b)() · 조건식 호출 …
  }
}

const isLocalName = (n: Node, sc: Scope): boolean => n.type === "Identifier" && sc.locals.has(n.name);

/** 노드 하나(와 그 아래)가 읽기만 하나. */
function readOnlyNode(n: Node, sc: Scope): boolean {
  switch (n.type) {
    case "AssignmentExpression": {
      const names: string[] = [];
      const flags = { member: false };
      patternNames(n.left, names, flags);
      if (flags.member || names.some((x) => !sc.locals.has(x))) return false;
      break;
    }
    case "UpdateExpression":
      if (!isLocalName(n.argument, sc)) return false; // 지역 변수의 ++ · -- 만 읽기 전용
      break;
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
        if (flags.member || names.some((x) => !sc.locals.has(x))) return false;
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
    case "CallExpression":
      if (!calleeAllowed(n.callee, sc)) return false;
      break;
    case "TaggedTemplateExpression":
      if (!calleeAllowed(n.tag, sc)) return false;
      break;
    case "NewExpression":
      if (!(n.callee.type === "Identifier" && READ_NEW.has(n.callee.name) && !sc.locals.has(n.callee.name))) return false;
      break;
  }
  for (const [k, v] of Object.entries(n)) {
    if (k === "type" || k === "start" || k === "end") continue;
    // 객체 글자값의 키(`{open: 1}`)와 점 뒤 이름(`a.open`)은 이름표일 뿐이라 따로(위의 MemberExpression · CallExpression)만 본다.
    if ((n.type === "MemberExpression" && k === "property" && !n.computed) || (n.type === "Property" && k === "key" && !n.computed) || (n.type === "MethodDefinition" && k === "key" && !n.computed) || (n.type === "PropertyDefinition" && k === "key" && !n.computed)) continue;
    const kids = Array.isArray(v) ? v : [v];
    for (const c of kids) if (c && typeof c === "object" && typeof (c as Node).type === "string" && !readOnlyNode(c as Node, sc)) return false;
  }
  return true;
}

/**
 * evaluate 에 넘긴 식(또는 함수) 소스가 페이지를 바꾸지 않는 읽기 전용인가 — 허락 목록 방식이다. 부르는 것이 읽기용으로 알려진 메서드 · 정해진 전역/정적 함수 · 식 안에서 선언한 함수일 때만
 * true 이고, 그 밖의 호출(페이지가 정의한 함수 등)은 무슨 일을 할지 모르므로 false. 대입(식 안에서 선언한 지역 변수 말고) · delete · fetch 류 이름도 false. 지역 변수의 ++ · -- 는 허락.
 * 못 읽으면(문법 이상 · 식을 빠져나가는 글) false.
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
  return readOnlyNode(program, scopeOf(program));
}
