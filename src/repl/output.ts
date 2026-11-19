import { inspect } from "node:util";
import { capSnapshot } from "../snapshot/diff.js";

/** console.log 한 줄: 글은 그대로, 나머지는 util.inspect. */
export function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, maxArrayLength: 100, breakLength: 80 }))).join(" ");
}

/** 한 호출에 붙일 수 있는 이미지 수. */
export const MAX_IMAGES = 4;

/** 한 호출에서 찍은 줄을 모은다. */
export class OutputBuffer {
  private lines: string[] = [];
  /** display() 로 붙인 이미지(PNG). */
  readonly images: Buffer[] = [];

  log(...args: unknown[]): void {
    this.lines.push(formatArgs(args));
  }

  /** 이미지를 붙인다. 한 호출에 MAX_IMAGES 장까지이고, 넘으면 붙이지 않고 안내 줄을 남긴다(한 번만). */
  addImage(img: Buffer): boolean {
    if (this.images.length >= MAX_IMAGES) {
      if (!this.warnedImages) {
        this.warnedImages = true;
        this.log(`이미지는 한 번에 ${MAX_IMAGES}장까지 붙일 수 있어요(나머지는 붙이지 않았어요)`);
      }
      return false;
    }
    this.images.push(img);
    return true;
  }

  private warnedImages = false;

  /** 줄을 이어 붙이고 16KB 에서 자른다(읽기 결과와 같은 자르기). */
  text(): string {
    return capSnapshot(this.lines.join("\n"));
  }
}
