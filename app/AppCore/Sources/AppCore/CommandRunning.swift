import Foundation

/// CLI 를 띄우는 쪽 — 실제로는 `ProcessRunner`, 시험에서는 가짜.
public protocol CommandRunning: Sendable {
    /// `onEvent` 는 어느 스레드에서 불려도 된다(실제 구현은 전용 직렬 큐). `run` 이 돌아오기 전에 모두 전달된다.
    func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
             onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome
    /// 돌고 있는 것을 멈춘다(돌고 있지 않으면 아무 일도 없다).
    func stop()
}

extension ProcessRunner: CommandRunning {}
