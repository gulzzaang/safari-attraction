import Foundation

/// 지금 사파리 탭 정보(「이 페이지 함께」).
public struct PageContext: Sendable, Equatable {
    public var title: String
    public var url: String
    public var selection: String?
    public init(title: String, url: String, selection: String? = nil) {
        self.title = title; self.url = url; self.selection = selection
    }
}

/// 앞 대화 한 마디.
public struct Turn: Sendable, Equatable {
    public enum Role: String, Sendable, Equatable { case user, assistant }
    public var role: Role
    public var text: String
    public init(role: Role, text: String) { self.role = role; self.text = text }
}

public struct AskRequest: Sendable, Equatable {
    public var question: String
    public var model: ModelKind
    public var webSearch: Bool
    public var page: PageContext?
    public var history: [Turn]
    public var claudeSessionID: String?
    public init(question: String, model: ModelKind, webSearch: Bool = false, page: PageContext? = nil,
                history: [Turn] = [], claudeSessionID: String? = nil) {
        self.question = question; self.model = model; self.webSearch = webSearch
        self.page = page; self.history = history; self.claudeSessionID = claudeSessionID
    }
}
