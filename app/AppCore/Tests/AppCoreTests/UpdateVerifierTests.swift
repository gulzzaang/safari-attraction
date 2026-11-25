import XCTest
import CryptoKit
@testable import AppCore

final class UpdateVerifierTests: XCTestCase {
    func testEmbeddedPublicKeyIsValidEd25519Key() throws {
        XCTAssertEqual(UpdateVerifier.publicKeyBase64, "lSt/H5rfQY5T2czBSxRphMTsgESQ+niPseiaZ/dRDEc=")
        let raw = try XCTUnwrap(Data(base64Encoded: UpdateVerifier.publicKeyBase64))
        XCTAssertEqual(raw.count, 32)
        _ = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
    }

    func testVerifySignatureValidAndTamperedAndWrongKeyAndBadBase64() throws {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKeyBase64 = privateKey.publicKey.rawRepresentation.base64EncodedString()
        let zipData = Data("fake-zip-payload-0.3.0".utf8)
        let signature = try privateKey.signature(for: zipData)
        let sigBase64 = signature.base64EncodedString()

        // 올바른 서명(줄바꿈 포함 포함)
        XCTAssertTrue(UpdateVerifier.verifySignature(zip: zipData, signatureBase64: sigBase64, publicKeyBase64: publicKeyBase64))
        XCTAssertTrue(UpdateVerifier.verifySignature(zip: zipData, signatureBase64: sigBase64 + "\n", publicKeyBase64: publicKeyBase64))

        // 한 바이트만 바뀐 zip
        var tampered = zipData
        tampered[0] ^= 0x01
        XCTAssertFalse(UpdateVerifier.verifySignature(zip: tampered, signatureBase64: sigBase64, publicKeyBase64: publicKeyBase64))

        // 다른 키로 검증
        let otherKey = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()
        XCTAssertFalse(UpdateVerifier.verifySignature(zip: zipData, signatureBase64: sigBase64, publicKeyBase64: otherKey))

        // 깨진 base64 · 빈 문자열
        XCTAssertFalse(UpdateVerifier.verifySignature(zip: zipData, signatureBase64: "!!!깨진base64!!!", publicKeyBase64: publicKeyBase64))
        XCTAssertFalse(UpdateVerifier.verifySignature(zip: zipData, signatureBase64: "", publicKeyBase64: publicKeyBase64))
        XCTAssertFalse(UpdateVerifier.verifySignature(zip: zipData, signatureBase64: sigBase64, publicKeyBase64: "not-valid-key"))
    }

    func testAllowedDownloadURL() {
        let allowed = [
            "https://github.com/gulzzaang/safari-attraction/releases/download/app-v0.2.0/SafariAttractionApp-0.2.0.zip",
            "https://GITHUB.COM/gulzzaang/safari-attraction/releases/download/app-v0.2.0/SafariAttractionApp-0.2.0.zip",
            "https://objects.githubusercontent.com/github-production-release-asset-123/asset.zip",
            "https://release-assets.githubusercontent.com/github-production-release-asset-123/asset.zip",
        ]
        for s in allowed {
            XCTAssertTrue(UpdateVerifier.allowedDownloadURL(URL(string: s)!), "허용 호스트여야 한다: \(s)")
        }

        let rejected = [
            "http://github.com/gulzzaang/safari-attraction/releases/download/app-v0.2.0/a.zip",
            "https://api.github.com/repos/gulzzaang/safari-attraction/releases",
            "https://evil.github.com/a.zip",
            "https://github.com.evil.com/a.zip",
            "https://objects.githubusercontent.com.evil.com/a.zip",
            "file:///tmp/SafariAttractionApp.zip",
            "http://127.0.0.1:8080/SafariAttractionApp-0.2.0.zip",
            "https://127.0.0.1:8080/SafariAttractionApp-0.2.0.zip",
        ]
        for s in rejected {
            XCTAssertFalse(UpdateVerifier.allowedDownloadURL(URL(string: s)!), "거절 호스트여야 한다: \(s)")
        }

        // 개발 빌드용 127.0.0.1 http 허용
        XCTAssertTrue(UpdateVerifier.allowedDownloadURL(URL(string: "http://127.0.0.1:8080/a.zip")!, allowLocalhostHTTP: true))
        XCTAssertFalse(UpdateVerifier.allowedDownloadURL(URL(string: "http://192.168.0.2:8080/a.zip")!, allowLocalhostHTTP: true))
        XCTAssertFalse(UpdateVerifier.allowedDownloadURL(URL(string: "http://example.com/a.zip")!, allowLocalhostHTTP: true))
    }
}
