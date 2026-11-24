import Foundation

/// 저장한 일 — 일 맡기기 입력에 이름을 붙여 둔 것.
public struct SavedTask: Codable, Equatable, Sendable, Identifiable {
    public var id: UUID
    public var name: String
    public var text: String

    public init(id: UUID = UUID(), name: String, text: String) {
        self.id = id
        self.name = name
        self.text = text
    }
}

/// 루틴 — 저장한 일 하나를 정해진 시각에 사람 없이(읽기만 · `sites` 안에서만) 돌리는 약속.
public struct Routine: Codable, Equatable, Sendable, Identifiable {
    public var id: UUID
    public var taskID: UUID
    public var schedule: RoutineSchedule
    /// 갈 수 있는 사이트(호스트). 비교는 `SiteList.allows`.
    public var sites: [String]
    public var enabled: Bool
    /// 실제로 돈 마지막 시각(화면 표시용).
    public var lastRun: Date?
    /// 돌렸거나 건너뛴 마지막 **예정 시각** — 일정 판단의 기준(`RoutineSchedule.decide`). 없으면 `createdAt` 부터 센다.
    public var lastHandled: Date?
    public var createdAt: Date

    public init(id: UUID = UUID(), taskID: UUID, schedule: RoutineSchedule, sites: [String], enabled: Bool = true, lastRun: Date? = nil, lastHandled: Date? = nil, createdAt: Date = Date()) {
        self.id = id
        self.taskID = taskID
        self.schedule = schedule
        self.sites = sites
        self.enabled = enabled
        self.lastRun = lastRun
        self.lastHandled = lastHandled
        self.createdAt = createdAt
    }

    /// 지금 무엇을 할지(`RoutineSchedule.decide`) — 기준은 `lastHandled ?? createdAt`.
    public func decide(now: Date, calendar: Calendar) -> ScheduleDecision {
        schedule.decide(now: now, lastHandled: lastHandled, createdAt: createdAt, calendar: calendar)
    }

    /// 화면에 보일 다음 예정 시각(지금 뒤 첫 칸).
    public func nextOccurrence(after now: Date, calendar: Calendar) -> Date {
        schedule.nextOccurrence(after: now, anchor: lastHandled ?? createdAt, calendar: calendar)
    }
}

/// 루틴 한 번의 결과 기록 한 줄.
public struct RoutineRecord: Codable, Equatable, Sendable {
    public static let answerLimit = 4000

    public static let statusDone = "끝남"
    public static let statusPartial = "일부만 됨"
    public static let statusFailed = "실패"
    public static func statusSkipped(_ reason: String) -> String { "건너뜀(\(reason))" }

    public var at: Date
    public var routineID: UUID
    public var name: String
    public var status: String
    /// 답 앞 4,000자(`RoutineStore.appendHistory` 가 자른다).
    public var answer: String

    public init(at: Date, routineID: UUID, name: String, status: String, answer: String) {
        self.at = at
        self.routineID = routineID
        self.name = name
        self.status = status
        self.answer = answer
    }
}

public enum RoutineStoreError: Error, Equatable {
    case emptyName
    case emptyText
    case unknownTask
    case unknownRoutine
}

/// `<앱 지원 폴더>/routines.json`(저장한 일 + 루틴)과 `<앱 지원 폴더>/routines/history.jsonl`(결과 기록, 최근 200개) 저장소.
/// 쓰기는 모두 atomic. 파일이 없으면 빈 것, 깨졌거나 못 읽은 파일도 빈 것으로 보고(앱이 죽지 않는다) 처음 덮어쓰기 전에 `.bak` 으로 남긴다
/// (`.bak` 도 못 남기면 덮어쓰지 않고 실패). `directory` 는 앱 지원 폴더 — 시험은 임시 폴더를 넣는다.
/// **앱에서는 한 폴더에 인스턴스 하나만 쓴다**: 잠금과 메모리 사본이 인스턴스 안에만 있어서, 같은 폴더를 두 인스턴스가 쓰면 서로의 변경을 덮어쓴다.
public final class RoutineStore: @unchecked Sendable {
    public static let fileName = "routines.json"
    public static let historyDirectoryName = "routines"
    public static let historyFileName = "history.jsonl"
    public static let historyLimit = 200

    private struct Document: Codable {
        var savedTasks: [SavedTask]
        var routines: [Routine]
    }

    private let directory: URL
    private let lock = NSLock()
    private var doc = Document(savedTasks: [], routines: [])
    private var records: [RoutineRecord] = []   // 오래된 것부터
    private var docCorrupt = false
    private var historyCorrupt = false

    public init(directory: URL) {
        self.directory = directory
        loadDocument()
        loadHistory()
    }

    private var fileURL: URL { directory.appendingPathComponent(Self.fileName) }
    private var historyDir: URL { directory.appendingPathComponent(Self.historyDirectoryName, isDirectory: true) }
    private var historyURL: URL { historyDir.appendingPathComponent(Self.historyFileName) }

    // MARK: 저장한 일 · 루틴

    public var savedTasks: [SavedTask] {
        lock.lock(); defer { lock.unlock() }
        return doc.savedTasks
    }

    public var routines: [Routine] {
        lock.lock(); defer { lock.unlock() }
        return doc.routines
    }

    public func savedTask(id: UUID) -> SavedTask? {
        lock.lock(); defer { lock.unlock() }
        return doc.savedTasks.first { $0.id == id }
    }

    public func routine(id: UUID) -> Routine? {
        lock.lock(); defer { lock.unlock() }
        return doc.routines.first { $0.id == id }
    }

    /// 새로 넣거나(같은 id 가 없으면) 고친다. 이름은 앞뒤 공백을 떼며, 이름 · 내용이 비면 `emptyName` · `emptyText`.
    @discardableResult
    public func upsertSavedTask(_ task: SavedTask) throws -> SavedTask {
        var t = task
        t.name = t.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.name.isEmpty else { throw RoutineStoreError.emptyName }
        guard !t.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw RoutineStoreError.emptyText }
        lock.lock(); defer { lock.unlock() }
        var next = doc
        if let i = next.savedTasks.firstIndex(where: { $0.id == t.id }) { next.savedTasks[i] = t } else { next.savedTasks.append(t) }
        try writeDocument(next)
        doc = next
        return t
    }

    /// 저장한 일을 지운다. 그 일을 가리키던 루틴도 함께 지운다(일 없는 루틴이 남아 돌지 않게). 없는 id 면 아무 일도 없다.
    public func removeSavedTask(id: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        guard doc.savedTasks.contains(where: { $0.id == id }) else { return }
        var next = doc
        next.savedTasks.removeAll { $0.id == id }
        next.routines.removeAll { $0.taskID == id }
        try writeDocument(next)
        doc = next
    }

    /// 새로 넣거나 고친다. 가리키는 저장한 일이 없으면 `unknownTask`. 사이트는 소문자 · 끝 점 떼기 · 빈 것 · 점 없는 낱말 · 공개 접미사(`co.kr`) · 중복 빼기로 맞춘다.
    @discardableResult
    public func upsertRoutine(_ routine: Routine) throws -> Routine {
        var r = routine
        r.sites = Self.cleanSites(r.sites)
        lock.lock(); defer { lock.unlock() }
        guard doc.savedTasks.contains(where: { $0.id == r.taskID }) else { throw RoutineStoreError.unknownTask }
        var next = doc
        if let i = next.routines.firstIndex(where: { $0.id == r.id }) { next.routines[i] = r } else { next.routines.append(r) }
        try writeDocument(next)
        doc = next
        return r
    }

    /// 화면에서 루틴을 만들거나 고쳐 저장한다 — `upsertRoutine` 에 「켜는 순간 기준 맞추기」 를 더한 것.
    /// 켜진 채 새로 만들거나, 꺼져 있던 것을 켜거나, 켜진 채 일정을 바꾸면 `lastHandled = now` 로 맞춘다
    /// (그렇지 않으면 옛 기준 뒤에 지나간 칸이 있어 켜자마자 「건너뜀(지나침)」 한 줄이 생긴다). 꺼진 채 저장하면 기준을 건드리지 않는다.
    @discardableResult
    public func saveRoutine(_ routine: Routine, now: Date) throws -> Routine {
        var r = routine
        let old = self.routine(id: r.id)
        if r.enabled, old == nil || old?.enabled == false || old?.schedule != r.schedule {
            r.lastHandled = now
        }
        return try upsertRoutine(r)
    }

    /// 한 루틴을 읽고 고쳐 저장한다(예: 실행 뒤 `lastRun` 갱신 — 화면에서 다른 칸을 고친 것을 덮어쓰지 않는다). 없는 id 면 `unknownRoutine`.
    @discardableResult
    public func updateRoutine(id: UUID, _ change: (inout Routine) -> Void) throws -> Routine {
        lock.lock(); defer { lock.unlock() }
        guard let i = doc.routines.firstIndex(where: { $0.id == id }) else { throw RoutineStoreError.unknownRoutine }
        var next = doc
        change(&next.routines[i])
        next.routines[i].id = id
        next.routines[i].sites = Self.cleanSites(next.routines[i].sites)
        try writeDocument(next)
        doc = next
        return next.routines[i]
    }

    /// 루틴을 지운다. 없는 id 면 아무 일도 없다(기록은 남는다).
    public func removeRoutine(id: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        guard doc.routines.contains(where: { $0.id == id }) else { return }
        var next = doc
        next.routines.removeAll { $0.id == id }
        try writeDocument(next)
        doc = next
    }

    private static func cleanSites(_ sites: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for s in sites {
            let n = SiteList.normalize(s)
            if SiteList.isUsableEntry(n), seen.insert(n).inserted { out.append(n) }   // 점 없는 낱말 · 공개 접미사(co.kr)는 저장하지 않는다
        }
        return out
    }

    // MARK: 기록

    /// 기록 한 줄을 덧붙인다. 답은 앞 4,000자만, 기록은 최근 200개만 남는다.
    public func appendHistory(_ record: RoutineRecord) throws {
        var r = record
        if r.answer.count > RoutineRecord.answerLimit { r.answer = String(r.answer.prefix(RoutineRecord.answerLimit)) }
        lock.lock(); defer { lock.unlock() }
        var next = records
        next.append(r)
        if next.count > Self.historyLimit { next.removeFirst(next.count - Self.historyLimit) }
        try writeHistory(next)
        records = next
    }

    /// 가장 최근 `limit` 개, 새것부터. 기본은 전부(최대 200개).
    public func history(limit: Int = RoutineStore.historyLimit) -> [RoutineRecord] {
        lock.lock(); defer { lock.unlock() }
        guard limit > 0 else { return [] }
        return Array(records.suffix(limit).reversed())
    }

    // MARK: 읽기 · 쓰기

    private static func makeEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }

    private static func makeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    private func loadDocument() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        guard let data = try? Data(contentsOf: fileURL),
              let loaded = try? Self.makeDecoder().decode(Document.self, from: data) else {
            docCorrupt = true   // 못 읽음 · 깨짐 — 덮어쓰기 전에 .bak 으로 남긴다
            return
        }
        doc = loaded
    }

    private func loadHistory() {
        guard FileManager.default.fileExists(atPath: historyURL.path) else { return }
        guard let data = try? Data(contentsOf: historyURL) else {
            historyCorrupt = true
            return
        }
        let decoder = Self.makeDecoder()
        var out: [RoutineRecord] = []
        for line in data.split(separator: UInt8(ascii: "\n")) where !line.allSatisfy({ $0 == 0x20 || $0 == 0x0D || $0 == 0x09 }) {
            if let rec = try? decoder.decode(RoutineRecord.self, from: Data(line)) { out.append(rec) } else { historyCorrupt = true }
        }
        records = Array(out.suffix(Self.historyLimit))
    }

    private func writeDocument(_ next: Document) throws {
        try prepare(file: fileURL, corrupt: &docCorrupt)
        let encoder = Self.makeEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(next).write(to: fileURL, options: .atomic)
    }

    private func writeHistory(_ next: [RoutineRecord]) throws {
        try prepare(file: historyURL, corrupt: &historyCorrupt)
        let encoder = Self.makeEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]   // 한 줄에 한 기록 — 줄바꿈 없이
        var data = Data()
        for r in next {
            data.append(try encoder.encode(r))
            data.append(UInt8(ascii: "\n"))
        }
        try data.write(to: historyURL, options: .atomic)
    }

    /// 폴더를 만들고, 깨졌거나 못 읽은 파일이 있으면 덮어쓰기 전에 `.bak` 으로 한 번 남긴다(못 남기면 던져서 덮어쓰지 않는다).
    private func prepare(file: URL, corrupt: inout Bool) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if corrupt {
            if fm.fileExists(atPath: file.path) {
                let backup = file.deletingLastPathComponent().appendingPathComponent(file.lastPathComponent + ".bak")
                try? fm.removeItem(at: backup)
                try fm.copyItem(at: file, to: backup)
            }
            corrupt = false
        }
    }
}
