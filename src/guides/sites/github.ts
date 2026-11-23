import type { SiteGuide } from "../types.js";

/** 깃허브 안내서. 이 맥 사파리 · 로그인된 상태에서 공개 저장소 화면만 보고 2026-11-23 확인(비공개 저장소 · 알림 · 설정은 열지 않음). */
export const github: SiteGuide = {
  id: "github",
  name: "깃허브",
  hosts: ["github.com"],
  summary:
    "저장소는 github.com/주인/저장소, 이슈 · 풀 리퀘스트는 끝에 /issues · /pulls. 최근 릴리스는 /releases/latest 로 가면 그 태그 쪽으로 넘어간다. 파일 보기 쪽의 내용 칸은 앞부분만 읽히니 전체는 raw.githubusercontent.com/주인/저장소/main/경로 를 fetch 한다. 화면은 영어이고 로그인된 계정이라 Star · Comment · Merge 가 진짜로 걸린다. 이 단추는 누르지 말고 사용자 확인.",
  body: `## 화면 구조
- 맨 위: 단추 "Open quick search dialog, type / to search", 단추 "Open Copilot…", 그 아래 탭 링크 Code · Issues · Pull requests · Agents · Actions · Projects · Security and quality · Insights.
- 저장소 쪽: 단추 Watch · Fork · "Star 주인/저장소", 단추 "main branch", 링크 "Branches" · "Tags"(앞에 개수가 붙는다), 칸 "Go to file", 단추 "Add file" · "Code". 파일 줄은 링크 "이름, (Directory)" · "이름, (File)" 꼴이고 바로 뒤에 최근 커밋 메시지 링크가 붙는다. 오른쪽 아래 Releases 에 최신 릴리스 이름 링크와 "Latest".
- 이슈 · 풀 리퀘스트 목록: 칸 "Search issues"(처음 값 is:issue state:open) · "Search pull requests", 링크 "Open (n)" · "Closed (n)", 단추 Filter by author · labels · assignees 등, "Sort by …", 링크 "New issue" · "New pull request". 한 쪽 25줄.
- 풀 리퀘스트 쪽: 링크 "Conversation (n)" · "Commits (n)" · "Checks (n)" · "Files changed (n)", 아래쪽 단추 "Comment" · "Close". 병합 단추는 권한이 있는 저장소에서만 보인다(미확인).
- 파일 보기 쪽: 단추 Code · Blame, 링크 Raw · History, 칸 "Go to file", 내용은 칸 "file content" 안에 들어 있다.

## 찾기와 읽기
- 저장소 https://github.com/주인/저장소 , 릴리스 /releases , 최근 릴리스 /releases/latest (→ /releases/tag/vX.Y.Z 꼴로 넘어간다), 파일 /blob/main/package.json , 이슈 /issues , 풀 리퀘스트 /pulls (모두 확인함).
- 검색: https://github.com/search?q=safari+mcp&type=repositories (확인함). type 을 code · issues · pullrequests 로 바꾸고 코드 검색은 q=repo%3A주인%2F저장소+단어&type=code 로 저장소 안만 찾는다(확인함, 코드 검색은 로그인 필요). 결과 줄 개수는 위쪽 링크 "Code (702k) results" 꼴로도 읽힌다. 결과가 늦게 채워져 4~5초 쉰 뒤 읽는다.
- 파일 전체: 내용 칸 snapshot 은 앞부분만 읽혀서, 같은 탭에서 page.evaluate 로 raw.githubusercontent.com/주인/저장소/main/경로 를 fetch 하면 글이 온다(공개 저장소로 확인함).
- 이슈 · 풀 리퀘스트 제목은 snapshot 에서 …로 잘리니 전체 제목은 evaluate 로 링크 글을 읽는다. 아이콘만 있는 링크 · 단추는 이름이 빈 글로 읽힌다.

## 자주 하는 일
1. 저장소 주소 열기 → 2. 릴리스 · 이슈 · 풀 리퀘스트 · 파일은 위 주소로 바로 가기 → 3. 파일은 Raw 주소를 fetch 해 읽기 → 4. 이름을 모르면 검색 주소로 찾고 결과 줄의 저장소 링크를 읽기.

## 함정
- 화면이 영어이고 로그인된 계정이다. Star · Watch · Fork · Comment 는 이 계정 이름으로 실제로 남는다.
- 검색 결과 줄마다 단추 "Star" 와 "Sponsor …" 가 붙어 있다. 줄을 누를 땐 저장소 이름 링크만 누른다.
- 다른 사람 풀 리퀘스트 쪽에도 댓글 칸과 "Comment" 단추가 있다. 칸에 아무것도 넣지 않는다.
- 비공개 저장소 · 알림 · 설정 · 계정 쪽은 사용자가 시키지 않았다면 열지 않는다. 공개 저장소에서도 사람 이름 · 메일 주소를 옮기지 않는다.
- 로그인 · 인증(2단계) 화면이 뜨면 멈추고 사용자에게 알린다.

## 사용자 확인이 꼭 필요한 일
- Star(가벼우나 확인) · Watch · Fork, 이슈 만들기(Submit new issue) · 댓글 작성(Comment), 풀 리퀘스트 병합(Merge) · 닫기(Close) · 다시 열기 · 리뷰 승인(Approve) · 변경 요청, 파일 고치기 · 커밋(Commit changes), 브랜치 · 태그 지우기, 저장소 지우기(Delete this repository) · 공개 범위 바꾸기 · 이름 바꾸기. 이 단추 앞에서 멈추고 저장소 · 쓸 글을 사용자에게 보여 준다.

## 못 본 곳
- 공개 저장소 화면만 봤다(저장소 쪽 · 릴리스 · 이슈 · 풀 리퀘스트 목록 · 파일 보기 · 검색). 병합 단추 · 새 이슈 양식 · Actions · 설정 · 비공개 저장소는 못 봤다.`,
  checked: "2026-11-23",
};
