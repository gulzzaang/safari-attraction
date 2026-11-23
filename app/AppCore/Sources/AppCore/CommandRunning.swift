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

/// 클로드를 양방향(표준 입력 파이프)으로 띄우는 쪽 — 실제로는 `ProcessRunner`, 시험에서는 가짜.
/// 첫 입력 줄은 `initialLines` 로 넘긴다(띄우기 전의 `write` 는 무시된다). `write` 는 최대 몇 초 막힐 수 있으니
/// 메인 스레드 · @MainActor 에서 부르지 않는다.
public protocol InteractiveRunning: Sendable {
    func runInteractive(executable: String, arguments: [String], workDir: URL, path: String,
                        timeout: TimeInterval, initialLines: [String],
                        onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome
    func write(_ line: String) throws
    func closeInput()
    func stop()
}

extension ProcessRunner: InteractiveRunning {}
