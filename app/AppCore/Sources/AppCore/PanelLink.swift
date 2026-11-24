import Foundation
import Security

public enum PanelLinkError: Error, Equatable {
    case randomFailed
    case writeFailed(String)
}

/// 앱과 사파리 확장을 잇는 연결 파일 `<지원 폴더>/panel-link.json`(0600) — `{ "port": 정수, "token": "64자 16진" }`.
/// 앱이 켜질 때 새 토큰 · 새 포트로 쓰고 꺼질 때 지운다. 토큰은 화면 · 기록 · 로그에 찍지 않는다.
public enum PanelLink {
    public static let fileName = "panel-link.json"
    public static let tokenByteCount = 32

    public static func fileURL(in directory: URL) -> URL { directory.appendingPathComponent(fileName) }

    /// `SecRandomCopyBytes` 32바이트 → 소문자 16진 64자.
    public static func makeToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: tokenByteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PanelLinkError.randomFailed }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// 파일을 처음부터 0600 으로 만들어 쓴 뒤 이름을 바꿔 올린다(쓴 다음 권한을 줄이는 틈이 없다).
    public static func write(port: UInt16, token: String, in directory: URL) throws {
        let json = "{\"port\":\(port),\"token\":\"\(token)\"}\n"
        let target = fileURL(in: directory)
        let temp = directory.appendingPathComponent(".\(fileName).\(UUID().uuidString.prefix(8)).tmp")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw PanelLinkError.writeFailed(String(cString: strerror(errno))) }
        let bytes = Array(json.utf8)
        var off = 0
        while off < bytes.count {
            let n = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + off, bytes.count - off) }
            if n <= 0 { let why = String(cString: strerror(errno)); close(fd); unlink(temp.path); throw PanelLinkError.writeFailed(why) }
            off += n
        }
        close(fd)
        if rename(temp.path, target.path) != 0 {
            let why = String(cString: strerror(errno))
            unlink(temp.path)
            throw PanelLinkError.writeFailed(why)
        }
    }

    public static func remove(in directory: URL) {
        unlink(fileURL(in: directory).path)
    }

    /// 상수 시간 비교 — 길이가 달라도 끝까지 훑는다.
    public static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = UInt8(truncatingIfNeeded: x.count ^ y.count)
        for i in 0..<max(x.count, y.count) {
            diff |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0)
        }
        return diff == 0
    }
}
