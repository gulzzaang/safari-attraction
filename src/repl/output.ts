import { inspect } from "node:util";
import { capSnapshot } from "../snapshot/diff.js";

/** console.log 한 줄: 글은 그대로, 나머지는 util.inspect. */
export function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, maxArrayLength: 100, breakLength: 80 }))).join(" ");
}

/** 한 호출에서 찍은 줄을 모은다. */
export class OutputBuffer {
  private lines: string[] = [];

  log(...args: unknown[]): void {
    this.lines.push(formatArgs(args));
  }

  /** 줄을 이어 붙이고 16KB 에서 자른다(읽기 결과와 같은 자르기). */
  text(): string {
    return capSnapshot(this.lines.join("\n"));
  }
}
