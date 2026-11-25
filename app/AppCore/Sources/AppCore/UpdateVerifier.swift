import Foundation
import CryptoKit

/// 업데이트 파일의 Ed25519 서명과 내려받기 호스트를 검증한다.
public enum UpdateVerifier {
    /// 앱 업데이트 검증용 고정 공개 키(base64, 비밀 아님).
    public static let publicKeyBase64 = "lSt/H5rfQY5T2czBSxRphMTsgESQ+niPseiaZ/dRDEc="

    /// 내려받기를 허용하는 HTTPS 호스트 목록.
    public static let allowedHosts: Set<String> = [
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    ]

    /// zip 바이트가 `signatureBase64` 와 `publicKeyBase64` 로 유효하게 서명됐는지 확인한다.
    public static func verifySignature(zip: Data, signatureBase64: String, publicKeyBase64: String = publicKeyBase64) -> Bool {
        let trimmedSig = signatureBase64.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSig.isEmpty, !trimmedKey.isEmpty,
              let sigData = Data(base64Encoded: trimmedSig),
              let keyData = Data(base64Encoded: trimmedKey),
              sigData.count == 64, keyData.count == 32 else {
            return false
        }
        guard let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData) else {
            return false
        }
        return publicKey.isValidSignature(sigData, for: zip)
    }

    /// 내려받기 주소(리다이렉트 도착지 포함)가 허용된 호스트인지 확인한다.
    /// `allowLocalhostHTTP` 는 개발 빌드(`#if SA_DEV_HOOKS`)에서 로컬 시험 주소를 쓸 때만 켠다.
    public static func allowedDownloadURL(_ url: URL, allowLocalhostHTTP: Bool = false) -> Bool {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return false }
        if scheme == "https" {
            return allowedHosts.contains(host)
        }
        if allowLocalhostHTTP && scheme == "http" {
            return host == "127.0.0.1"
        }
        return false
    }
}
