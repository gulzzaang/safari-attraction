import type { SiteGuide } from "../types.js";
import { coupang } from "./coupang.js";
import { naverMap } from "./naver-map.js";
import { naverSearch } from "./naver-search.js";
import { naverShopping } from "./naver-shopping.js";

/** 내장 사이트 안내서 목록. 안내서마다 이 폴더에 `.ts` 문자열 모듈로 두고 여기에 더한다. */
export const GUIDES: SiteGuide[] = [coupang, naverSearch, naverShopping, naverMap];
