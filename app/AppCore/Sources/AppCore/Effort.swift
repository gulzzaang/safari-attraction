import Foundation

/// 생각(추론) 단계 이름 · CLI 별 선택 목록.
public enum Effort {
    public static let claudeLevels = ["low", "medium", "high", "xhigh", "max"]
    public static let opencodeLevels = ["low", "medium", "high", "xhigh", "max"]

    /// 단계 원시 이름을 화면에 보일 한국어로 바꾼다. 모르는 값은 원문 그대로.
    public static func label(_ raw: String) -> String {
        switch raw {
        case "low": return "낮음"
        case "medium": return "보통"
        case "high": return "높음"
        case "xhigh": return "매우 높음"
        case "max": return "최대"
        case "none": return "생각 안 함"
        case "minimal": return "아주 낮음"
        case "ultra": return "울트라"
        case "thinking": return "생각함"
        default: return raw
        }
    }
}

/// CLI 가 도구를 부를 때 옆 창 · 패널 진행 한 줄에 보일 문구.
public enum ToolActivity {
    public static func label(for toolName: String) -> String {
        let low = toolName.lowercased()
        if low.contains("search") || low.contains("web_search") { return "검색 중 …" }
        if low.contains("fetch") || low.contains("read_url") { return "페이지 읽는 중 …" }
        if low.contains("safari-attraction") || low.contains("repl") || low.contains("snapshot") { return "사파리 보는 중 …" }
        return "도구 쓰는 중 …"
    }
}
