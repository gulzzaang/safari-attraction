import Foundation

public enum GateLinkError: Error, Equatable {
    case writeFailed(String)
}

/// 앱과 MCP 서버를 잇는 관문 연결 파일 `<지원 폴더>/gate-link.json`(0600) — `{ "socket": "…", "token": "…" }`.
/// 앱이 켜질 때 쓰고 꺼질 때 지운다. 토큰은 명령줄이나 설정 파일에 넣지 않는다.
public enum GateLink {
    public static let fileName = "gate-link.json"

    public static func url(support: URL) -> URL {
        support.appendingPathComponent(fileName)
    }

    /// 파일을 처음부터 0600 으로 만들어 쓴 뒤 이름을 바꿔 올린다(쓴 다음 권한을 줄이는 틈이 없다).
    public static func write(_ info: GateInfo, support: URL) throws {
        let payload: [String: String] = ["socket": info.socketPath, "token": info.token]
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(payload)
        data.append(0x0A)
        let target = url(support: support)
        let temp = support.appendingPathComponent(".\(fileName).\(UUID().uuidString.prefix(8)).tmp")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw GateLinkError.writeFailed(String(cString: strerror(errno))) }
        let bytes = Array(data)
        var off = 0
        while off < bytes.count {
            let n = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + off, bytes.count - off) }
            if n <= 0 {
                let why = String(cString: strerror(errno))
                close(fd)
                unlink(temp.path)
                throw GateLinkError.writeFailed(why)
            }
            off += n
        }
        close(fd)
        if rename(temp.path, target.path) != 0 {
            let why = String(cString: strerror(errno))
            unlink(temp.path)
            throw GateLinkError.writeFailed(why)
        }
    }

    public static func remove(support: URL) {
        unlink(url(support: support).path)
    }
}
