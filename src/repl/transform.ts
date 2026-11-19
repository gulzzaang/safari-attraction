import { parse } from "acorn";

type Edit = { start: number; end: number; text: string };

/**
 * 한 번 돌릴 코드(REPL 한 호출)를 고쳐 쓴다.
 * - 최상위 `const / let / var` 는 컨텍스트 전역 대입으로 바꾼다(다음 호출에도 남는다). 구조 분해도 된다.
 *   `const` 라도 다시 선언할 수 있게 느슨해진다(Aside 의 REPL 도 같다).
 * - 최상위 `function` · `class` 선언은 이름 없는 식으로 바꿔 전역에 대입한다. 함수는 맨 앞으로 끌어올려
 *   선언 앞에서도 부를 수 있다.
 * - 전체를 `(async () => { … })()` 로 감싸 top-level await 가 된다.
 * 함수 · 블록 · 반복문 안의 선언은 건드리지 않는다. 문법 오류는 한국어로 던진다.
 */
export function hoistTopLevel(code: string): string {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (e) {
    throw new SyntaxError(`문법 오류: ${(e as Error).message}`);
  }
  const edits: Edit[] = [];
  const hoisted: string[] = [];
  for (const node of ast.body) {
    if (node.type === "VariableDeclaration") {
      const parts = node.declarations.map((d) => {
        const id = code.slice(d.id.start, d.id.end);
        return `${id} = ${d.init ? code.slice(d.init.start, d.init.end) : "undefined"}`;
      });
      edits.push({ start: node.start, end: node.end, text: `(${parts.join(", ")});` });
    } else if (node.type === "FunctionDeclaration" && node.id) {
      hoisted.push(`${node.id.name} = ${code.slice(node.start, node.id.start)}${code.slice(node.id.end, node.end)};`);
      edits.push({ start: node.start, end: node.end, text: "" });
    } else if (node.type === "ClassDeclaration" && node.id) {
      edits.push({ start: node.start, end: node.end, text: `${node.id.name} = ${code.slice(node.start, node.id.start)}${code.slice(node.id.end, node.end)};` });
    }
  }
  let body = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, e.start) + e.text + body.slice(e.end);
  return `(async () => {\n${hoisted.join("\n")}\n${body}\n})()`;
}
