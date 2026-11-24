import Foundation
import SafariServices
import Darwin

/// 사파리 확장 ↔ 앱 사이의 네이티브 핸들러(샌드박스 안에서 돈다).
/// 하는 일은 하나: background 가 「연결 정보」를 달라고 하면 앱이 써 둔 `panel-link.json` 을 읽어 `{ port, token }` 으로 돌려준다.
/// 파일이 없거나 못 읽으면 `{ error: "…" }`. 토큰은 로그에 남기지 않는다(이 파일은 `print` · `NSLog` · `os_log` 를 쓰지 않는다).
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    static let appOffMessage = "사파리-어트랙션 앱을 켜 주세요(메뉴 막대 나침반)"
    static let badLinkMessage = "앱의 연결 정보가 올바르지 않아요 — 앱을 껐다 켜 주세요"
    static let unknownRequestMessage = "알 수 없는 요청이에요"
    static let relativePath = "/Library/Application Support/SafariAttractionApp/panel-link.json"

    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]
        // 정해진 요청(getLink)에만 연결 정보를 준다. 그 밖의 요청은 오류.
        let reply: [String: Any] = Self.isGetLink(message) ? Self.linkReply() : ["error": Self.unknownRequestMessage]
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// `{ type: "getLink" }` — 사파리 버전에 따라 `{ message: { type: "getLink" } }` 로 한 겹 싸여 올 수 있어 둘 다 받는다.
    static func isGetLink(_ message: Any?) -> Bool {
        guard let dict = message as? [String: Any] else { return false }
        if dict["type"] as? String == "getLink" { return true }
        if let inner = dict["message"] as? [String: Any], inner["type"] as? String == "getLink" { return true }
        return false
    }

    /// 샌드박스 안에서 `NSHomeDirectory()` · `homeDirectoryForCurrentUser` 는 컨테이너 경로다. 진짜 홈은 사용자 DB 에서 읽는다.
    static func realHomeDirectory() -> String? {
        guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { return nil }
        let home = String(cString: dir)
        return home.isEmpty ? nil : home
    }

    static func linkReply() -> [String: Any] {
        guard let home = realHomeDirectory() else { return ["error": appOffMessage] }
        return linkReply(atPath: home + relativePath)
    }

    /// 파일 내용을 `{ port, token }` 으로 걸러 낸다(모양이 틀리면 오류) — 다른 키는 넘기지 않는다.
    static func linkReply(atPath path: String) -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: path) else { return ["error": appOffMessage] }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let port = (object["port"] as? NSNumber)?.intValue, port >= 1, port <= 65535,
              let token = object["token"] as? String, isToken(token) else {
            return ["error": badLinkMessage]
        }
        return ["port": port, "token": token]
    }

    static func isToken(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
}
