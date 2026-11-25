#!/usr/bin/env swift
import Foundation
import CryptoKit
import Security

/// 업데이트 zip 파일에 Ed25519 서명을 만들거나(`sign-update.swift <zip>`),
/// 만든 서명을 공개 키로 검증한다(`sign-update.swift --verify <zip> <sig> [publicKeyBase64]`).
/// 비밀 키는 로그인 키체인 일반 암호 항목(service: safari-attraction-update-signing, account: release)에서 읽으며
/// 어떤 경우에도 비밀 키 원문을 출력하지 않는다.

let keychainService = "safari-attraction-update-signing"
let keychainAccount = "release"
let defaultPublicKeyBase64 = "lSt/H5rfQY5T2czBSxRphMTsgESQ+niPseiaZ/dRDEc="

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func decodeHex(_ s: String) -> Data? {
    let chars = Array(s)
    guard chars.count % 2 == 0 else { return nil }
    var data = Data(capacity: chars.count / 2)
    var idx = 0
    while idx < chars.count {
        guard let byte = UInt8(String(chars[idx..<(idx + 2)]), radix: 16) else { return nil }
        data.append(byte)
        idx += 2
    }
    return data
}

func parseEd25519PrivateKey(from rawSecret: Data) -> Curve25519.Signing.PrivateKey? {
    // 1. 32바이트 원시 키
    if rawSecret.count == 32, let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: rawSecret) {
        return key
    }

    // 2. UTF-8 문자열(base64 · PEM · hex)
    guard let text = String(data: rawSecret, encoding: .utf8) else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    let base64Body: String
    if trimmed.contains("BEGIN PRIVATE KEY") {
        base64Body = trimmed
            .split(whereSeparator: \.isNewline)
            .filter { !$0.hasPrefix("-----") }
            .joined()
    } else {
        base64Body = trimmed
    }

    if let decoded = Data(base64Encoded: base64Body) {
        if decoded.count == 32, let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: decoded) {
            return key
        }
        // PKCS#8 DER (48바이트: 16바이트 헤더 + 32바이트 시드)
        let pkcs8Prefix = Data([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
        if decoded.count == 48, decoded.starts(with: pkcs8Prefix) {
            let seed = Data(decoded.suffix(32))
            if let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) {
                return key
            }
        }
    }

    if trimmed.count == 64, let hexData = decodeHex(trimmed),
       let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: hexData) {
        return key
    }

    return nil
}

func readPrivateKeyFromKeychain() -> Curve25519.Signing.PrivateKey {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: keychainAccount,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let secretData = item as? Data else {
        fail("오류: 키체인에서 업데이트 서명 키를 읽지 못했어요(status=\(status))")
    }
    guard let key = parseEd25519PrivateKey(from: secretData) else {
        fail("오류: 키체인의 업데이트 서명 키 형식이 올바르지 않아요")
    }
    return key
}

func verify(zipPath: String, sigPath: String, publicKeyBase64: String) {
    guard let zipData = try? Data(contentsOf: URL(fileURLWithPath: zipPath)) else {
        fail("오류: zip 파일을 읽지 못했어요 — \(zipPath)")
    }
    guard let sigText = try? String(contentsOfFile: sigPath, encoding: .utf8) else {
        fail("오류: 서명 파일을 읽지 못했어요 — \(sigPath)")
    }
    let trimmedSig = sigText.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedKey = publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let sigData = Data(base64Encoded: trimmedSig),
          let keyData = Data(base64Encoded: trimmedKey),
          let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
          publicKey.isValidSignature(sigData, for: zipData) else {
        fail("오류: 서명 검증에 실패했어요")
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--verify" {
    guard args.count == 3 || args.count == 4 else {
        fail("사용법: sign-update.swift --verify <zip> <sig> [publicKeyBase64]")
    }
    let pubKey = args.count == 4 ? args[3] : defaultPublicKeyBase64
    verify(zipPath: args[1], sigPath: args[2], publicKeyBase64: pubKey)
    exit(0)
}

guard args.count == 1, !args[0].isEmpty else {
    fail("사용법: sign-update.swift <zip>")
}

let zipURL = URL(fileURLWithPath: args[0])
guard let zipData = try? Data(contentsOf: zipURL) else {
    fail("오류: zip 파일을 읽지 못했어요 — \(args[0])")
}

let privateKey = readPrivateKeyFromKeychain()
do {
    let signature = try privateKey.signature(for: zipData)
    print(signature.base64EncodedString())
} catch {
    fail("오류: 서명을 만들지 못했어요")
}
