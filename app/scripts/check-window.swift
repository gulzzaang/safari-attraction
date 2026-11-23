#!/usr/bin/env swift
// 창 위치 확인(개발용) — 사파리 · 이 앱의 창 bounds 와 소유 앱 이름만 찍는다(창 제목은 읽지 않는다).
// 사용: swift app/scripts/check-window.swift
import CoreGraphics
import Foundation

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []

struct W { let owner: String; let layer: Int; let rect: CGRect }
func rect(_ d: [String: Any]) -> CGRect {
    guard let b = d[kCGWindowBounds as String] as? [String: Any] else { return .zero }
    return CGRect(x: (b["X"] as? CGFloat) ?? 0, y: (b["Y"] as? CGFloat) ?? 0,
                  width: (b["Width"] as? CGFloat) ?? 0, height: (b["Height"] as? CGFloat) ?? 0)
}
let ws = list.compactMap { d -> W? in
    guard let o = d[kCGWindowOwnerName as String] as? String else { return nil }
    guard o == "Safari" || o == "SafariAttractionApp" || o == "사파리-어트랙션" else { return nil }
    let r = rect(d)
    guard r.width > 100, r.height > 100 else { return nil }
    return W(owner: o, layer: (d[kCGWindowLayer as String] as? Int) ?? -1, rect: r)
}
for w in ws { print("\(w.owner) layer=\(w.layer) x=\(Int(w.rect.minX)) y=\(Int(w.rect.minY)) w=\(Int(w.rect.width)) h=\(Int(w.rect.height))") }
// 목록은 앞쪽 창부터 — 첫 사파리 창이 앞 창이다.
if let safari = ws.first(where: { $0.owner == "Safari" }), let ours = ws.first(where: { $0.owner != "Safari" }) {
    let gap = ours.rect.minX - safari.rect.maxX
    print("옆 창 왼쪽 - 사파리 오른쪽 = \(Int(gap)) (기대 8)   높이 차 = \(Int(ours.rect.height - safari.rect.height)) (기대 0)")
} else if ws.first(where: { $0.owner != "Safari" }) != nil {
    print("이 앱 창만 보임(사파리 창 없음)")
} else {
    print("이 앱 창이 화면에 없음")
}
