/** 프로세스 바깥까지 올라온 거부 · 오류를 받는 쪽이 필요로 하는 것. */
export interface GuardOptions {
  /** REPL 호출 코드에서 비롯됐으면 그 호출 출력에 알리고 true(ReplSession.handleStray). */
  handleStray(reason: unknown, kind: "rejection" | "exception"): boolean;
  /** 서버를 정상 종료한다(우리가 연 탭을 닫고 끝낸다). */
  stop(code: number): void | Promise<void>;
  log(message: string, err: unknown): void;
}

/**
 * 처리 안 된 거부와 잡히지 않은 오류가 서버를 죽이지 않게 한다.
 * - unhandledRejection: 로그만 남기고(REPL 호출 코드 것이면 그 호출 출력에도 한 줄) 계속 돈다.
 * - uncaughtException: REPL 호출 코드(타이머 · 콜백)에서 난 것이면 같은 식으로 살린다. 서버 자신의 것이면
 *   로그를 남기고 정상 종료 절차(우리 탭 닫기)를 거쳐 끝낸다.
 * 돌려주는 함수로 핸들러를 뗀다(시험용).
 */
export function installProcessGuards(proc: NodeJS.Process, o: GuardOptions): () => void {
  const safely = (f: () => void) => {
    try {
      f();
    } catch {
      // 핸들러 안의 오류로 또 죽지 않는다.
    }
  };
  const onRejection = (reason: unknown) => {
    safely(() => o.log("[safari-attraction] 처리 안 된 거부(무시하고 계속):", reason));
    safely(() => void o.handleStray(reason, "rejection"));
  };
  const onException = (err: unknown) => {
    safely(() => o.log("[safari-attraction] 잡히지 않은 오류:", err));
    let fromRepl = false;
    safely(() => {
      fromRepl = o.handleStray(err, "exception");
    });
    if (!fromRepl) void o.stop(1);
  };
  proc.on("unhandledRejection", onRejection);
  proc.on("uncaughtException", onException);
  return () => {
    proc.off("unhandledRejection", onRejection);
    proc.off("uncaughtException", onException);
  };
}
