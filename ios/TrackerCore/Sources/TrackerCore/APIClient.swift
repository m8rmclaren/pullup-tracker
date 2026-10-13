import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Sends a request and returns the body and status. URLSession in the app; a fake in tests.
public protocol HTTPSending: Sendable {
    func send(_ request: URLRequest) async throws -> (body: Data, status: Int)
}

public struct URLSessionSender: HTTPSending {
    public init() {}

    public func send(_ request: URLRequest) async throws -> (body: Data, status: Int) {
        try await withCheckedThrowingContinuation { continuation in
            URLSession.shared.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0))
                }
            }.resume()
        }
    }
}

public struct RequestTimedOut: Error, LocalizedError {
    public var errorDescription: String? { "Request timed out" }
}

/// POSTs JSON to the API, as the PWA's api.ts does.
public struct APIClient: SyncTransport {
    public static let timeoutSeconds: TimeInterval = 15

    public let baseURL: URL
    private let sender: any HTTPSending

    public init(baseURL: URL, sender: any HTTPSending = URLSessionSender()) {
        self.baseURL = baseURL
        self.sender = sender
    }

    public func makeRequest(path: String, body: Data, token: String?) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Self.timeoutSeconds)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // CloudFront's origin access control signs requests to the Lambda URL with SigV4, and for a
        // request with a body it requires the viewer to supply the payload hash.
        request.setValue(sha256Hex(body), forHTTPHeaderField: "x-amz-content-sha256")
        if let token { request.setValue(token, forHTTPHeaderField: "x-pullup-token") }
        return request
    }

    public func post<Response: Decodable>(_ path: String, _ payload: some Encodable, token: String? = nil, as responseType: Response.Type = Response.self) async throws -> Response {
        let request = makeRequest(path: path, body: try JSONEncoder().encode(payload), token: token)
        let (body, status): (Data, Int)
        do {
            (body, status) = try await sender.send(request)
        } catch let error as URLError where error.code == .timedOut {
            throw RequestTimedOut()
        }
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: body))?.error ?? "HTTP \(status)"
            throw HTTPError(status: status, message: message)
        }
        return try JSONDecoder().decode(responseType, from: body)
    }

    private struct ErrorBody: Decodable {
        let error: String?
    }

    public func sync(_ request: SyncRequest, token: String) async throws -> SyncResponse {
        try await post("/api/sync", request, token: token)
    }

    public func pushProfile(_ patch: ProfilePatch, token: String) async throws -> Account {
        try await post("/api/profile", patch, token: token)
    }
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { byte in
        let hex = String(byte, radix: 16)
        return byte < 16 ? "0" + hex : hex
    }.joined()
}
