class SafariAttraction < Formula
  desc "평소 로그인된 사파리를 Claude 가 쓰게 하는 MCP 서버"
  homepage "https://github.com/gulzzaang/safari-attraction"
  url "https://github.com/gulzzaang/safari-attraction.git", tag: "v0.1.0"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install "plugin/server.mjs"
    (libexec/"jxa").install "plugin/jxa/host.js"

    # 등록 경로는 버전이 들어간 Cellar 경로가 아니라 opt 경로다. 업그레이드해도 그대로 살아 있다.
    (bin/"safari-attraction").write <<~SH
      #!/bin/sh
      export SAFARI_ATTRACTION_BIN="#{opt_bin}/safari-attraction"
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/server.mjs" "$@"
    SH
    chmod 0755, bin/"safari-attraction"
  end

  def caveats
    <<~EOS
      Claude 에 연결하려면:
        safari-attraction setup

      준비가 됐는지 확인하려면:
        safari-attraction doctor

      사파리 설정 두 가지가 필요합니다.
        1. 사파리 → 설정 → 고급 → '웹 개발자용 기능 보기' 켜기
        2. 메뉴 막대 개발 → 'Apple 이벤트의 JavaScript 허용' 켜기
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/safari-attraction --version")
  end
end
