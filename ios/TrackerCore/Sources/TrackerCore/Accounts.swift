import Foundation

// Signing a device in: device links, and passkeys in the WebAuthn JSON the server's
// SimpleWebAuthn speaks. The platform's passkey API works in bytes, so this converts between
// the two; the ceremony itself is in the app.

/// What every way of signing a device in returns: a device link, a sign-up, a passkey sign-in.
public struct SessionResponse: Codable, Hashable, Sendable {
    public var token: String
    public var account: Account
}

/// POST /api/signup/options. `timeZone` is the device's zone, kept as the new account's.
public struct SignupOptionsRequest: Codable, Hashable, Sendable {
    public var name: String
    public var timeZone: String
    public var dailyGoalReps: Int?
    public var linkCode: String?

    public init(name: String, timeZone: String, dailyGoalReps: Int? = nil, linkCode: String? = nil) {
        self.name = name
        self.timeZone = timeZone
        self.dailyGoalReps = dailyGoalReps
        self.linkCode = linkCode
    }
}

/// The parts of the server's creation options the platform needs.
public struct PasskeyCreationOptions: Decodable, Hashable, Sendable {
    public struct RelyingParty: Decodable, Hashable, Sendable {
        public var id: String
        public var name: String
    }

    public struct User: Decodable, Hashable, Sendable {
        public var id: String
        public var name: String
        public var displayName: String
    }

    public struct Excluded: Decodable, Hashable, Sendable {
        public var id: String
    }

    public var challenge: String
    public var rp: RelyingParty
    public var user: User
    public var excludeCredentials: [Excluded]?
}

/// The parts of the server's request options the platform needs. No allowCredentials: the device offers any passkey it has for the domain.
public struct PasskeyRequestOptions: Decodable, Hashable, Sendable {
    public var challenge: String
    public var rpId: String
}

/// A new passkey, as SimpleWebAuthn's RegistrationResponseJSON.
public struct PasskeyRegistration: Encodable, Hashable, Sendable {
    public struct Response: Encodable, Hashable, Sendable {
        public var clientDataJSON: String
        public var attestationObject: String
        public var transports: [String]
    }

    public var id: String
    public var rawId: String
    public var response: Response
    public var type = "public-key"
    public var clientExtensionResults: [String: String] = [:]
    public var authenticatorAttachment = "platform"

    public init(credentialId: Data, clientDataJSON: Data, attestationObject: Data) {
        id = Base64URL.encode(credentialId)
        rawId = id
        response = Response(clientDataJSON: Base64URL.encode(clientDataJSON), attestationObject: Base64URL.encode(attestationObject), transports: ["internal", "hybrid"])
    }
}

/// A passkey assertion, as SimpleWebAuthn's AuthenticationResponseJSON.
public struct PasskeyAssertion: Encodable, Hashable, Sendable {
    public struct Response: Encodable, Hashable, Sendable {
        public var clientDataJSON: String
        public var authenticatorData: String
        public var signature: String
        public var userHandle: String
    }

    public var id: String
    public var rawId: String
    public var response: Response
    public var type = "public-key"
    public var clientExtensionResults: [String: String] = [:]
    public var authenticatorAttachment = "platform"

    public init(credentialId: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userHandle: Data) {
        id = Base64URL.encode(credentialId)
        rawId = id
        response = Response(clientDataJSON: Base64URL.encode(clientDataJSON), authenticatorData: Base64URL.encode(authenticatorData), signature: Base64URL.encode(signature), userHandle: Base64URL.encode(userHandle))
    }
}

/// POST /api/signup, /api/passkey/login and /api/passkey/register: the authenticator's response, and a name for this device.
public struct PasskeyRequest<Credential: Encodable & Sendable>: Encodable, Sendable {
    public var credential: Credential
    public var label: String

    public init(credential: Credential, label: String) {
        self.credential = credential
        self.label = label
    }
}

/// Unpadded base64url, the encoding WebAuthn JSON uses for bytes.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }
}

extension APIClient {
    public func redeemDeviceLink(code: String) async throws -> SessionResponse {
        try await post("/api/join", ["code": code])
    }

    public func signupOptions(_ request: SignupOptionsRequest) async throws -> PasskeyCreationOptions {
        try await post("/api/signup/options", request)
    }

    public func finishSignup(_ registration: PasskeyRegistration, label: String) async throws -> SessionResponse {
        try await post("/api/signup", PasskeyRequest(credential: registration, label: label))
    }

    public func loginOptions() async throws -> PasskeyRequestOptions {
        try await post("/api/passkey/login/options", [String: String]())
    }

    public func finishLogin(_ assertion: PasskeyAssertion, label: String) async throws -> SessionResponse {
        try await post("/api/passkey/login", PasskeyRequest(credential: assertion, label: label))
    }
}
