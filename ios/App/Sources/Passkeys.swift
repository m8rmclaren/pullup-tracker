import AuthenticationServices
import TrackerCore
import UIKit

/// Runs one passkey ceremony with the system sheet. The server's options come in as WebAuthn
/// JSON; what the platform returns goes back out as WebAuthn JSON (see TrackerCore's Accounts).
@MainActor
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, any Error>?

    struct InvalidOptions: Error, LocalizedError {
        var errorDescription: String? { "The server sent passkey options this app can't read." }
    }

    func register(with options: PasskeyCreationOptions) async throws -> PasskeyRegistration {
        guard let challenge = Base64URL.decode(options.challenge), let userId = Base64URL.decode(options.user.id) else { throw InvalidOptions() }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rp.id)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: options.user.name, userID: userId)
        request.userVerificationPreference = .required
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration, let attestationObject = credential.rawAttestationObject else {
            throw InvalidOptions()
        }
        return PasskeyRegistration(credentialId: credential.credentialID, clientDataJSON: credential.rawClientDataJSON, attestationObject: attestationObject)
    }

    func assert(with options: PasskeyRequestOptions) async throws -> PasskeyAssertion {
        guard let challenge = Base64URL.decode(options.challenge) else { throw InvalidOptions() }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else { throw InvalidOptions() }
        return PasskeyAssertion(credentialId: credential.credentialID, clientDataJSON: credential.rawClientDataJSON, authenticatorData: credential.rawAuthenticatorData, signature: credential.signature, userHandle: credential.userID)
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated {
            continuation?.resume(returning: authorization)
            continuation = nil
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        MainActor.assumeIsolated {
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }

    /// What to tell someone when a passkey step fails; a dismissed Face ID sheet isn't worth a paragraph.
    static func message(for error: any Error) -> String? {
        if let authorizationError = error as? ASAuthorizationError, authorizationError.code == .canceled { return nil }
        return (error as? HTTPError)?.message ?? error.localizedDescription
    }
}

/// "iPhone", "iPad": a name for this device's passkey and session.
@MainActor
var deviceLabel: String {
    UIDevice.current.model
}
