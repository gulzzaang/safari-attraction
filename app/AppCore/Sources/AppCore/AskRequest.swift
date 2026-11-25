import Foundation

/// 지금 사파리 탭 정보.
public struct PageContext: Sendable, Equatable {
    public var title: String
    public var url: String
    public var selection: String?
    public init(title: String, url: String, selection: String? = nil) {
        self.title = title; self.url = url; self.selection = selection
    }
}

/// 사파리 MCP 도구를 붙일 때 넘기는 경로 모음(관문 토큰은 넣지 않고 `gate-link.json` 경로만 넘긴다).
public struct SafariTools: Sendable, Equatable {
    public let runScript: String
    public let gateFile: String
    public let memoryHome: String

    public init(runScript: String, gateFile: String, memoryHome: String) {
        self.runScript = runScript
        self.gateFile = gateFile
        self.memoryHome = memoryHome
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
    public var page: PageContext?
    public var history: [Turn]
    public var claudeSessionID: String?
    /// 고른 모델 id(클로드 `sonnet` 등 · codex 슬러그). nil 이면 기본(클로드 sonnet · codex 는 `-m` 없이).
    public var modelID: String?
    /// 생각(추론) 단계. nil 이면 기본(플래그 안 붙임).
    public var effort: String?
    /// 사파리 MCP 도구를 붙일 때만 채운다. nil 이면 도구 없이 답만 한다.
    public var safariTools: SafariTools?

    public init(question: String, model: ModelKind, page: PageContext? = nil,
                history: [Turn] = [], claudeSessionID: String? = nil, modelID: String? = nil,
                effort: String? = nil, safariTools: SafariTools? = nil) {
        self.question = question; self.model = model
        self.page = page; self.history = history; self.claudeSessionID = claudeSessionID
        self.modelID = modelID; self.effort = effort; self.safariTools = safariTools
    }
}
