import Foundation
import Testing
@testable import TrackerCore

@Suite("labels")
struct LabelsTests {
    @Test func holdsAndCounts() {
        #expect([45, 60, 90, 3600].map(formatHoldSeconds) == ["45s", "1m", "1m 30s", "60m"])
        #expect(formatCount(6, unit: "rep") == "6")
        #expect(formatCount(3, unit: "lap") == "3 laps")
        #expect(formatCount(1, unit: "lap") == "1 lap")
        #expect(Entry(id: "a", doneAt: 1, exerciseId: "plank", holdSeconds: 90, updatedAt: 1).formattedAmount(unitOf: builtInUnit) == "1m 30s")
    }

    @Test func linkCodes() {
        let code = "AbCdEfGh_jKlMnOp-1234"
        #expect(Links.deviceCode(in: "https://pullups.example.com/#device=\(code)\n") == code)
        #expect(Links.deviceCode(in: "  \(code) ") == code)
        #expect(Links.deviceCode(in: "https://pullups.example.com/#device=short") == nil)
        #expect(Links.deviceCode(in: "not a code at all, has spaces") == nil)
        #expect(Links.joinCode(in: "https://pullups.example.com/#join=\(code)") == code)
    }
}

@Suite("passkey JSON")
struct PasskeyJSONTests {
    @Test func base64URLRoundTripsWithoutPadding() {
        let bytes = Data([0xfb, 0xff, 0xfe, 0x00, 0x01])
        #expect(Base64URL.encode(bytes) == "-__-AAE")
        #expect(Base64URL.decode("-__-AAE") == bytes)
        #expect(Base64URL.decode("dXNlcg") == Data("user".utf8))
    }

    @Test func readsSimpleWebAuthnOptions() throws {
        let creation = try JSONDecoder().decode(PasskeyCreationOptions.self, from: Data(#"{"challenge":"Y2hhbGxlbmdl","rp":{"name":"Pull-ups","id":"pullups.example.com"},"user":{"id":"dXNlcg","name":"Hay","displayName":"Hay"},"pubKeyCredParams":[{"alg":-7,"type":"public-key"}],"timeout":300000,"attestation":"none","excludeCredentials":[],"authenticatorSelection":{"residentKey":"required","userVerification":"required"}}"#.utf8))
        #expect(creation.rp.id == "pullups.example.com" && Base64URL.decode(creation.user.id) == Data("user".utf8))
        let request = try JSONDecoder().decode(PasskeyRequestOptions.self, from: Data(#"{"challenge":"Y2hhbGxlbmdl","timeout":300000,"rpId":"pullups.example.com","userVerification":"required"}"#.utf8))
        #expect(request.rpId == "pullups.example.com")
    }

    @Test func writesTheShapeSimpleWebAuthnVerifies() throws {
        let assertion = PasskeyAssertion(credentialId: Data([1, 2]), clientDataJSON: Data("{}".utf8), authenticatorData: Data([3]), signature: Data([4]), userHandle: Data("u1".utf8))
        let json = try JSONValue(encoding: assertion)
        #expect(json["id"] == .string("AQI") && json["rawId"] == .string("AQI") && json["type"] == .string("public-key"))
        #expect(json["response"]?["userHandle"] == .string("dTE"))
        #expect(json["clientExtensionResults"] == .object([:]))
    }
}
