import Foundation

/// 「묻기」 한 번의 가운데 부분 — 옆 창(`ChatViewModel`)과 페이지 패널 서버(`PanelAskService`)가 같이 쓴다.
/// 안내 · 프롬프트 상한 · 로그인 셸 PATH · 작업 폴더 · codex 로그인 확인 · 제미나이 로그인 확인 · CLI 실행 · 출력 읽기까지.
/// 사파리 읽기 · 말풍선 · 대화 기록은 부르는 쪽 몫이다.
public enum AskFlow {
    /// 흐름이 밖으로 내는 것. `emit` 은 어느 스레드에서 불려도 된다(순서는 지킨다).
    public enum Step: Sendable, Equatable {
        /// 답 앞에 보일 안내.
        case notice(String)
        /// CLI 출력에서 읽은 이벤트.
        case event(StreamEvent)
        /// CLI 를 띄우기 전에 막힌 이유(한국어 한 줄) — 부르는 쪽이 오류로 보인다.
        case failure(String)
    }

    /// 한 번의 실행 동안 CLI 가 내는 이벤트를 읽는 쪽(전용 큐에서 불리므로 잠근다).
    private final class ReaderBox: @unchecked Sendable {
        private let lock = NSLock()
        private var reader: ModelOutputReader
        init(model: ModelKind) { reader = ModelOutputReader(model: model) }
        func handle(_ e: RunEvent) -> [StreamEvent] { lock.withLock { reader.handle(e) } }
        func finish(_ o: RunOutcome) -> [StreamEvent] { lock.withLock { reader.finish(outcome: o) } }
    }

    private final class ErrorBuffer: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        func append(_ m: String) { lock.withLock { items.append(m) } }
        var all: [String] { lock.withLock { items } }
    }

    /// - Parameters:
    ///   - geminiLoggedOut: 제미나이가 로그인이 안 된 걸 이미 아는가(안 된 걸 알면 agy 를 띄우지 않는다).
    ///   - emit: 안내 · 이벤트 · 막힌 이유를 순서대로 받는다. 돌아오기 전에 모두 전달된다.
    /// - Returns: 실행 결과. 막혀서 띄우지 못했으면 `.failed`, 멈췄으면(작업 취소 포함) `.stopped`.
    public static func run(request: AskRequest, runner: CommandRunning,
                           loginPath: @escaping @Sendable () -> String,
                           workDirectory: @escaping @Sendable () throws -> URL,
                           supportDirectory: (@Sendable () throws -> URL)? = nil,
                           timeout: TimeInterval,
                           geminiLoggedOut: @escaping @Sendable () async -> Bool,
                           emit: @escaping @Sendable (Step) -> Void) async -> RunOutcome {
        if Task.isCancelled { return .stopped }
        if let notice = CommandBuilder.notice(for: request) { emit(.notice(notice)) }

        if CommandBuilder.exceedsPromptLimit(request) {
            // 너무 긴 질문은 CLI 를 띄우지 않는다.
            emit(.failure(CommandBuilder.promptTooLongMessage))
            return .failed(CommandBuilder.promptTooLongMessage)
        }

        // 막힐 수 있는 일(로그인 셸 PATH 는 앱이 켜진 뒤 첫 질문에서 처음 읽고 캐시 — 최대 8초)은 메인 밖에서.
        let prepared: Result<(path: String, dir: URL, support: URL), Error> = await Task.detached(priority: .userInitiated) {
            do {
                let dir = try workDirectory()
                let sup = try supportDirectory?() ?? dir.deletingLastPathComponent()
                return .success((loginPath(), dir, sup))
            } catch { return .failure(error) }
        }.value

        if Task.isCancelled { return .stopped }
        switch prepared {
        case .failure(let e):
            emit(.failure("작업 폴더를 만들지 못했어요 — \(e.localizedDescription)"))
            return .failed("작업 폴더를 만들지 못했어요(\(e.localizedDescription))")
        case .success(let p):
            if request.model == .chatgpt, !(await codexReady(runner: runner, (path: p.path, dir: p.dir), emit: emit)) {
                return Task.isCancelled ? .stopped : .failed("codex 로그인을 확인하지 못했어요")
            }
            if request.model == .gemini, await geminiLoggedOut() {
                // 로그인이 안 된 걸 이미 아는 agy 는 띄우지 않는다(로그인 안 된 채 -p 가 어떻게 끝나는지 모름).
                emit(.failure(ModelKind.gemini.loginNeededMessage))
                return .failed(ModelKind.gemini.loginNeededMessage)
            }

            let effort = request.effort?.isEmpty == false ? request.effort : nil
            let canRetryVariant = request.model == .opencode && effort != nil
            let firstErrors = ErrorBuffer()
            let first = await execute(request: request, runner: runner, path: p.path, workDir: p.dir, support: p.support, timeout: timeout) { e in
                if canRetryVariant, case .error(let msg) = e {
                    firstErrors.append(msg)
                } else {
                    emit(.event(e))
                }
            }
            if canRetryVariant, let effort {
                let errs = firstErrors.all
                let variantUnavailable = errs.contains { $0.localizedCaseInsensitiveContains("variant unavailable") }
                if variantUnavailable, !Task.isCancelled, first != .stopped {
                    emit(.notice("이 모델은 「\(Effort.label(effort))」 을 못 받아서 기본으로 물었어요"))
                    var retry = request
                    retry.effort = nil
                    return await execute(request: retry, runner: runner, path: p.path, workDir: p.dir, support: p.support, timeout: timeout) { e in
                        emit(.event(e))
                    }
                }
                for msg in errs { emit(.event(.error(msg))) }
            }
            return first
        }
    }

    private static func execute(request: AskRequest, runner: CommandRunning, path: String, workDir: URL, support: URL,
                                timeout: TimeInterval, emit: @escaping @Sendable (StreamEvent) -> Void) async -> RunOutcome {
        let built = CommandBuilder.build(request, workDir: workDir, support: support)
        let box = ReaderBox(model: request.model)
        let outcome = await runner.run(executable: built.executable, arguments: built.arguments, workDir: workDir,
                                       path: path, timeout: timeout, environment: built.environment) { event in
            for e in box.handle(event) { emit(e) }
        }
        for e in box.finish(outcome) { emit(e) }
        return outcome
    }

    /// codex 는 묻기 전에 늘 `codex login status`(같은 환경) — 로그인이 안 됐으면 프로세스를 띄우지 않는다
    /// (로그인 안 된 채 `codex exec` 는 20초 넘게 재시도한다). 막았으면 한국어 한 줄을 `.failure` 로 내고 false.
    private static func codexReady(runner: CommandRunning, _ p: (path: String, dir: URL),
                                   emit: @Sendable (Step) -> Void) async -> Bool {
        let c = CLICommands.codexLoginStatus
        let o = await runner.run(executable: c.executable, arguments: c.arguments, workDir: p.dir, path: p.path,
                                 timeout: CLICommands.readTimeout) { _ in }
        if Task.isCancelled { return false }
        let message: String
        switch o {
        case .finished(0): return true
        case .finished(1): message = ModelKind.chatgpt.loginNeededMessage
        case .finished(let code): message = "codex 로그인 상태를 확인하지 못했어요(종료 코드 \(code)) — 설정에서 확인해 주세요"
        case .notFound: message = ModelKind.chatgpt.notFoundMessage
        case .stopped: return false
        case .failed(let why) where why.hasPrefix("앱 전용 설정 폴더"): message = why
        case .timedOut, .failed: message = "codex 로그인 상태를 확인하지 못했어요 — 설정에서 확인해 주세요"
        }
        emit(.failure(message))
        return false
    }
}
