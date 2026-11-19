import { execFileSync } from "node:child_process";
import { describe } from "vitest";
import { startFixtureServer } from "../fixtures/server.js";

/** 통합 시험(실제 사파리를 부린다)은 SAFARI_IT=1 일 때만 돈다. */
export const describeIt: typeof describe = process.env.SAFARI_IT ? describe : (describe.skip as typeof describe);

let baseUrl: string | undefined;
let stop: (() => Promise<void>) | undefined;

/** 시험 서버를 띄운다. beforeAll 에서 부르고, 끝나면 stopFixtures 를 부른다. */
export async function startFixtures(): Promise<void> {
  const s = await startFixtureServer();
  baseUrl = s.baseUrl;
  stop = s.close;
}

export async function stopFixtures(): Promise<void> {
  await stop?.();
  baseUrl = undefined;
  stop = undefined;
}

/** 시험 서버의 페이지 주소. startFixtures 뒤에만 쓴다. */
export function fixture(name: string): string {
  if (!baseUrl) throw new Error("startFixtures() 를 먼저 부르세요");
  return `${baseUrl}/${name}`;
}

/** 지금 맨 앞 앱의 이름(`lsappinfo`). */
export function frontApp(): string {
  const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
  const out = execFileSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8" });
  const m = /"([^"]*)"/.exec(out);
  return m ? m[1]! : "";
}
