import { inspect } from "node:util";
import { capSnapshot } from "../snapshot/diff.js";

/** console.log 한 줄: 글은 그대로, 나머지는 util.inspect. */
export function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, maxArrayLength: 100, breakLength: 80 }))).join(" ");
}

/** 한 호출에 붙일 수 있는 이미지 수. */
export const MAX_IMAGES = 4;

/** 최종 출력을 보고 자기 기억을 맞추는 것(읽기 결과: 실제로 찍힌 만큼만 「읽은 줄」로 친다). */
export interface Settlable {
  settle(output: string): void;
}

/** 한 호출에서 찍은 줄을 모은다. */
export class OutputBuffer {
  private lines: string[] = [];
  private readonly watched = new Set<Settlable>();

  /** 이 호출의 최종 출력이 정해지면 settle 을 불러 줄 것들을 등록한다. */
  watch(p: Settlable): void {
    this.watched.add(p);
  }
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
    const out = capSnapshot(this.lines.join("\n"));
    // 나중에 올린 것부터 되돌려야 기억이 실제로 보인 상태로 돌아간다.
    for (const p of [...this.watched].reverse()) p.settle(out);
    this.watched.clear();
    return out;
  }
}
