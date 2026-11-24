// 사파리 확장 아이콘 만들기 — SF Symbol 「safari」(나침반)를 단색 PNG 여러 크기로 그린다. build.sh 가 부른다.
// 사용: make-icons <출력 폴더>   (창 · 앱을 띄우지 않고 이미지로만 그린다. 실패하면 0 이 아닌 종료 코드 — build.sh 는 아이콘 없이 간다.)
import AppKit

let args = CommandLine.arguments
guard args.count == 2 else { FileHandle.standardError.write(Data("사용: make-icons <출력 폴더>\n".utf8)); exit(2) }
let outDir = URL(fileURLWithPath: args[1], isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let color = NSColor(srgbRed: 0x6e / 255.0, green: 0x6e / 255.0, blue: 0x73 / 255.0, alpha: 1)

func render(size: Int) -> Data? {
    guard let symbol = NSImage(systemSymbolName: "safari", accessibilityDescription: nil) else { return nil }
    let px = CGFloat(size)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    rep.size = NSSize(width: px, height: px)
    guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    let config = NSImage.SymbolConfiguration(pointSize: px * 0.9, weight: .regular)
    let configured = symbol.withSymbolConfiguration(config) ?? symbol
    let inset = px * 0.06
    let rect = NSRect(x: inset, y: inset, width: px - inset * 2, height: px - inset * 2)
    // 알파 모양만 쓰고 한 가지 색으로 채운다(단색).
    let tinted = NSImage(size: rect.size)
    tinted.lockFocus()
    configured.draw(in: NSRect(origin: .zero, size: rect.size), from: .zero, operation: .sourceOver, fraction: 1)
    color.set()
    NSRect(origin: .zero, size: rect.size).fill(using: .sourceIn)
    tinted.unlockFocus()
    tinted.draw(in: rect)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

for size in [16, 32, 48, 64, 96, 128, 256] {
    guard let data = render(size: size), data.count > 100 else {
        FileHandle.standardError.write(Data("아이콘 \(size) 을 그리지 못했어요\n".utf8)); exit(1)
    }
    try data.write(to: outDir.appendingPathComponent("icon-\(size).png"))
}
