import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { SafariError } from "./types.js";

/** JXA 호스트가 보낸 오류 답. */
export class HostError extends Error {
  number?: number;
  code?: string;
  constructor(message: string, number?: number, code?: string) {
    super(message);
    this.name = "HostError";
    this.number = number;
    this.code = code;
  }
}

/** 요청이 시간 안에 끝나지 않아 호스트를 죽였다. */
export class HostTimeoutError extends Error {
  constructor(public op: string, public timeoutMs: number) {
    super(`${op} 이(가) ${timeoutMs}ms 안에 끝나지 않음`);
    this.name = "HostTimeoutError";
  }
}

const HOST_PATH = new URL("./jxa/host.js", import.meta.url).pathname;

// 입력을 ASCII 로만 보낸다(호스트가 읽기 청크 경계에서 한글이 잘릴 일이 없게).
function toAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

interface Pending {
  id: number;
  op: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 떠 있는 `osascript -l JavaScript host.js` 프로세스 하나와 줄 단위로 말한다.
 * 요청은 한 번에 하나씩 차례로 보내고(JXA 는 한 줄기), 시간은 실제로 보낸 때부터 잰다.
 * 시간이 넘으면 프로세스를 죽이고 다음 요청 때 다시 띄운다.
 */
export class JxaHost {
  private child: ChildProcess | null = null;
  private pending: Pending | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private stderrTail = "";
  private closed = false;

  constructor(private defaultTimeoutMs: number) {}

  call(op: string, args: object = {}, timeoutMs?: number): Promise<unknown> {
    const run = () => this.exec(op, args, timeoutMs ?? this.defaultTimeoutMs);
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private spawnChild(): ChildProcess {
    const child = spawn("osascript", ["-l", "JavaScript", HOST_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.stderrTail = "";
    const decoder = new StringDecoder("utf8");
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += decoder.write(d);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== "") this.onLine(child, line);
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    child.stdin!.on("error", () => {});
    child.on("error", (e) => this.onChildGone(child, `osascript 를 띄우지 못함: ${e.message}`));
    child.on("exit", (code, signal) =>
      this.onChildGone(child, `JXA 호스트가 끝남(code=${code}, signal=${signal}) ${this.stderrTail.trim()}`),
    );
    return child;
  }

  private onLine(child: ChildProcess, line: string): void {
    if (child !== this.child) return;
    let msg: { id: number | null; ok: boolean; value?: unknown; error?: { message: string; number?: number; code?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 호스트가 아닌 잡음
    }
    const p = this.pending;
    if (!p || msg.id !== p.id) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new HostError(msg.error?.message ?? "알 수 없는 오류", msg.error?.number, msg.error?.code));
  }

  private onChildGone(child: ChildProcess, why: string): void {
    if (child !== this.child) return;
    this.child = null;
    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new SafariError("SAFARI_ERROR", why));
    }
  }

  private exec(op: string, args: object, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new SafariError("SAFARI_ERROR", "드라이버가 이미 닫힘"));
    const child = this.child ?? this.spawnChild();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        this.child = null;
        child.kill("SIGKILL");
        reject(new HostTimeoutError(op, timeoutMs));
      }, timeoutMs);
      this.pending = { id, op, resolve, reject, timer };
      child.stdin!.write(toAsciiJson({ id, op, args }) + "\n");
    });
  }

  /** 호스트를 끝낸다(stdin 을 닫으면 스스로 끝난다, 안 끝나면 죽인다). */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin!.end();
    });
  }
}
