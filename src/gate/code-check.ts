/**
 * repl 코드에 덧막이(Node · JS 전역 우회) 낱말이 들었는지 검사한다.
 * Swift 의 `AgentSession.codeWrapperPattern` 과 같은 정규식을 쓴다.
 */
export const CODE_WRAPPER_PATTERN = /\b(constructor|process|require|child_process|Function|eval|globalThis|prototype)\b|import\(|__proto__/;

export function hasWrapperWord(code: string): boolean {
  return CODE_WRAPPER_PATTERN.test(code);
}
