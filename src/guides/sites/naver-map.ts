import type { SiteGuide } from "../types.js";

/** 네이버 지도 안내서. 이 맥 사파리 · 로그인된 상태 화면으로 2026-11-23 확인. */
export const naverMap: SiteGuide = {
  id: "naver-map",
  name: "네이버 지도",
  hosts: ["map.naver.com", "pcmap.place.naver.com"],
  summary:
    "검색은 map.naver.com/p/search/장소 로 연다. 결과 목록은 다른 사이트 iframe 안이라 snapshot 에 한 줄뿐이다. page.evaluate 로 document.getElementById('searchIframe').src 를 읽어 그 주소(또는 pcmap.place.naver.com/place/list?query=장소)를 열면 읽힌다. 장소 상세는 pcmap.place.naver.com/place/번호/home. 저장 · 공유 · 예약 · 리뷰 등록은 사용자 확인.",
  body: `## 화면 구조
- 왼쪽 위: 네이버지도 · 지도 홈 · 길찾기 · 버스 · 지하철 · 기차 · 저장, 검색칸 "네이버지도 검색", 단추 "검색" · "삭제".
- 왼쪽 패널: 검색 결과 목록(iframe "searchIframe", 다른 사이트라 안이 안 읽힘), 장소를 고르면 상세(iframe "entryIframe").
- 지도 쪽 단추: 일반지도 · 위성지도 · 지형지도 · 거리뷰 · 확대 · 축소.

## 찾기와 읽기
- 장소 검색: https://map.naver.com/p/search/서울역 (열리는 데 5초 안팎).
- 목록은 iframe 주소를 따로 연다. 짧은 꼴도 된다: https://pcmap.place.naver.com/place/list?query=서울역
- 목록 한 칸: 장소 이름 + 분류(예: 서울역 (고속철도) KTX정차역), 영업 상태, "서울 용산구 동자동" 같은 동 단위 주소, 출발 · 도착 단추. "현재 위치에서 N km" 는 사용자 위치 기준이라 말하지 않는다. 같은 이름이 여러 곳(고속철도 · 지하철 호선별)으로 나뉜다. 광고 · 플레이스 플러스 표시 칸도 섞일 수 있다.
- 도로명 전체 주소는 상세 화면에 있다. 장소 번호는 목록 페이지 소스의 "id":"숫자" 에서 얻는다.
- 상세: https://pcmap.place.naver.com/place/번호/home (또는 https://map.naver.com/p/entry/place/번호). 탭 홈 · 리뷰 · 사진 · 정보, 주소 단추(예: 서울 용산구 한강대로 405), 영업시간, 전화 · 홈페이지.

## 자주 하는 일
1. 검색 주소 열기 → 2. iframe 주소로 목록 열기 → 3. 맨 위 장소의 이름 · 주소 읽기 → 4. 주소가 더 필요하면 번호로 상세 열기.

## 함정
- 지도 화면 안 목록 칸은 클릭도 못 한다(다른 사이트 iframe). 위 방법으로 바깥에서 연다.
- 상세의 리뷰 글 · 작성자 이름 · 번호는 개인 글이라 옮기지 않는다.
- 로그인 · 추가 인증이 뜨면 멈춘다. 저장 목록(MY) 안의 글은 읽지 않는다.

## 사용자 확인이 꼭 필요한 일
- 저장(즐겨찾기 추가), 공유(Share), 예약 · 주문, 리뷰 · 사진 등록, 정보 수정 제안, 길찾기 결과 보내기(Send)는 누르기 전에 사용자 확인.

## 못 본 곳
- 저장 · 공유 · 예약 · 리뷰 등록 단추와 길찾기 결과 화면은 열어 보지 않았다(미확인). 지도 화면 안 단추는 이름만 봤다.`,
  checked: "2026-11-23",
};
