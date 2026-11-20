#!/bin/sh
# 플러그인 서버 실행기: 쓸 만한 node(18 이상)를 찾아 server.mjs 를 띄운다.
# Claude Code 를 Dock · 런처로 켜면 PATH 에 nvm · 홈브루 node 가 없을 수 있어서 흔한 자리를 직접 뒤진다.
here="$(dirname "$0")"

# nvm 은 버전 숫자순(v9 < v18 < v26)으로, 새것부터 늘어놓는다.
nvm_newest() {
  for p in "$HOME"/.nvm/versions/node/v*/bin/node; do
    [ -x "$p" ] || continue
    d="${p%/bin/node}"
    printf '%s %s\n' "${d##*/v}" "$p"
  done | sort -t. -k1,1nr -k2,2nr -k3,3nr | while IFS= read -r line; do
    printf '%s\n' "${line#* }"
  done
}

candidates() {
  command -v node 2>/dev/null
  printf '%s\n' /opt/homebrew/bin/node /usr/local/bin/node
  nvm_newest
  printf '%s\n' "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" "$HOME/.local/share/fnm/aliases/default/bin/node" /opt/local/bin/node
}

# 첫 번째로 쓸 만한 node 를 고른다. (exec 는 반복문 밖에서 해야 MCP 의 표준 입력이 그대로 서버로 간다.)
pick() {
  candidates | while IFS= read -r n; do
    [ -x "$n" ] || continue
    major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null </dev/null)" || continue
    case "$major" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$major" -ge 18 ]; then
      printf '%s\n' "$n"
      break
    fi
  done
}

node_bin="$(pick)"
if [ -n "$node_bin" ]; then
  exec "$node_bin" "$here/server.mjs" "$@"
fi

echo '사파리-어트랙션: Node 18 이상을 찾지 못했어요. https://nodejs.org 에서 설치하거나 `brew install node` 후 Claude Code 를 다시 켜 주세요.' >&2
exit 1
