#!/bin/zsh
# 앱 릴리스 스크립트 — app/VERSION 기준으로 앱을 빌드 · 압축 · Ed25519 서명 · 검증하고 GitHub 릴리스를 올린다.
# --dry-run 을 넘기면 gh release create 전까지만 실행하고 산출물 경로를 출력한다.
# GitHub 인증은 부르는 쪽이 GH_TOKEN 환경 값으로 넘긴다(계정을 바꾸지 않는다).
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "사용법: $0 [--dry-run]" >&2
      exit 1
      ;;
  esac
done

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/.." && pwd)"
VERSION_FILE="$APP_DIR/VERSION"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "릴리스 실패: 버전 파일이 없어요 — $VERSION_FILE" >&2
  exit 1
fi

VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
if [[ ! "$VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  echo "릴리스 실패: app/VERSION 형식이 올바르지 않아요 — '$VERSION'" >&2
  exit 1
fi

TAG="app-v${VERSION}"

# 1. 작업 트리가 깨끗한지, 태그 app-v<ver> 가 아직 없는지 확인한다.
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "릴리스 실패: 작업 트리에 커밋되지 않은 변경이 있어요" >&2
  exit 1
fi
if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "릴리스 실패: 태그 $TAG 이 이미 있어요" >&2
  exit 1
fi

# 2. 앱 빌드
"$APP_DIR/scripts/build.sh"
APP_BUNDLE="$APP_DIR/.build/SafariAttractionApp.app"
if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "릴리스 실패: 빌드 결과 앱을 찾지 못했어요 — $APP_BUNDLE" >&2
  exit 1
fi

# 3. zip 생성
RELEASE_DIR="$APP_DIR/.build/release"
mkdir -p "$RELEASE_DIR"
ZIP_PATH="$RELEASE_DIR/SafariAttractionApp-${VERSION}.zip"
SIG_PATH="${ZIP_PATH}.sig"
rm -f "$ZIP_PATH" "$SIG_PATH"
ditto -c -k --norsrc --noextattr --keepParent "$APP_BUNDLE" "$ZIP_PATH"

# 4. Ed25519 서명 생성 및 공개 키로 재확인
swift "$APP_DIR/scripts/sign-update.swift" "$ZIP_PATH" > "$SIG_PATH"
if [[ ! -s "$SIG_PATH" ]]; then
  echo "릴리스 실패: 서명 파일이 비어 있어요 — $SIG_PATH" >&2
  exit 1
fi
swift "$APP_DIR/scripts/sign-update.swift" --verify "$ZIP_PATH" "$SIG_PATH"
echo "서명 확인 완료: $SIG_PATH"

# 5. 릴리스 노트 준비(app/RELEASE_NOTES.md 우선, 없으면 커밋 제목 목록)
NOTES_FILE="$RELEASE_DIR/release-notes-${VERSION}.md"
if [[ -f "$APP_DIR/RELEASE_NOTES.md" ]]; then
  cp "$APP_DIR/RELEASE_NOTES.md" "$NOTES_FILE"
else
  PREV_TAG="$(git -C "$REPO_ROOT" tag -l 'app-v*' --sort=-v:refname | head -n 1 || true)"
  if [[ -n "$PREV_TAG" ]]; then
    git -C "$REPO_ROOT" log --pretty=format:'- %s' "${PREV_TAG}..HEAD" > "$NOTES_FILE"
  else
    git -C "$REPO_ROOT" log -n 20 --pretty=format:'- %s' HEAD > "$NOTES_FILE"
  fi
  if [[ ! -s "$NOTES_FILE" ]]; then
    echo "- 사파리-어트랙션 앱 ${VERSION}" > "$NOTES_FILE"
  fi
fi

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry-run 완료(GitHub 릴리스는 만들지 않았어요):"
  echo "  태그: $TAG"
  echo "  커밋: $HEAD_SHA"
  echo "  zip: $ZIP_PATH"
  echo "  sig: $SIG_PATH"
  echo "  노트: $NOTES_FILE"
  exit 0
fi

# 6. GitHub 릴리스 생성(부르는 쪽의 GH_TOKEN 사용, --latest=false 유지)
gh release create "$TAG" \
  --repo gulzzaang/safari-attraction \
  --target "$HEAD_SHA" \
  --latest=false \
  --title "사파리-어트랙션 앱 ${VERSION}" \
  --notes-file "$NOTES_FILE" \
  "$ZIP_PATH" "$SIG_PATH"
