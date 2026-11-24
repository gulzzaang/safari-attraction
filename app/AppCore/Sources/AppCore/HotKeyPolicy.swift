import Foundation

/// ⌘E 단축키를 지금 등록해 둘지 — 사파리(또는 이 앱)가 맨 앞일 때만 등록하고, 다른 앱이 앞이면 풀어서
/// 다른 앱의 ⌘E 를 빼앗지 않는다. 순수 함수라 시험에서 맨 앞 앱만 바꿔 넣어 본다.
public enum HotKeyPolicy {
    public static let safariBundleID = "com.apple.Safari"

    /// - Parameters:
    ///   - frontmostBundleID: 맨 앞 앱의 번들 ID(모르면 nil).
    ///   - ownBundleID: 이 앱의 번들 ID.
    /// - Returns: 사파리가 앞이거나 이 앱이 앞이면 true(등록), 그 밖이면 false(해제).
    public static func shouldRegisterCommandE(frontmostBundleID: String?, ownBundleID: String?) -> Bool {
        guard let front = frontmostBundleID else { return false }
        if front == safariBundleID { return true }
        if let own = ownBundleID, front == own { return true }
        return false
    }
}
