import CoreGraphics

/// 옆 창 자리 계산(좌표계는 사파리 창과 화면이 같기만 하면 된다).
public enum PanelPlacement {
    /// 사파리 창 오른쪽 바깥 `gap` 띄워 `width` 폭, 높이는 사파리와 같게.
    /// 사파리 창이 놓인 화면(겹침이 가장 큰 화면) 안에 다 들어가지 않으면 사파리 창 안쪽 오른쪽에 겹친다.
    /// 이웃 화면으로 삐져나가지 않는다.
    public static func frame(safari: CGRect, screens: [CGRect], width: CGFloat = 380, gap: CGFloat = 8) -> CGRect {
        guard let screen = homeScreen(of: safari, in: screens) else {
            return CGRect(x: safari.maxX + gap, y: safari.minY, width: width, height: safari.height)
        }
        // 세로는 화면 안으로.
        let minY = max(safari.minY, screen.minY)
        let maxY = min(safari.maxY, screen.maxY)
        let height = max(maxY - minY, 0) > 0 ? maxY - minY : min(safari.height, screen.height)
        let outsideX = safari.maxX + gap
        if outsideX + width <= screen.maxX {
            return CGRect(x: outsideX, y: minY, width: width, height: height)
        }
        let w = min(width, screen.width)
        let insideX = min(max(safari.maxX - w, screen.minX), screen.maxX - w)
        return CGRect(x: insideX, y: minY, width: w, height: height)
    }

    /// 사파리가 없을 때의 기본 자리 — 첫(주) 화면의 오른쪽 가장자리, 화면 높이만큼.
    public static func defaultFrame(screens: [CGRect], width: CGFloat = 380) -> CGRect {
        guard let s = screens.first else { return CGRect(x: 0, y: 0, width: width, height: 800) }
        let w = min(width, s.width)
        return CGRect(x: s.maxX - w, y: s.minY, width: w, height: s.height)
    }

    private static func homeScreen(of safari: CGRect, in screens: [CGRect]) -> CGRect? {
        var best: (CGRect, CGFloat)?
        for s in screens {
            let i = s.intersection(safari)
            let area = i.isNull ? 0 : i.width * i.height
            if best == nil || area > best!.1 { best = (s, area) }
        }
        guard let (screen, area) = best else { return nil }
        if area > 0 { return screen }
        // 어느 화면과도 안 겹치면(화면 밖으로 나간 창) 가장 가까운 화면.
        return screens.min { distance(safari, $0) < distance(safari, $1) }
    }

    private static func distance(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let dx = max(b.minX - a.maxX, a.minX - b.maxX, 0)
        let dy = max(b.minY - a.maxY, a.minY - b.maxY, 0)
        return dx * dx + dy * dy
    }
}
