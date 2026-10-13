// The /api/sync and /api/profile wire formats, as in model.ts and profile.ts.

/// The sync protocol this code speaks. A request without it is from a client that would strip fields it doesn't know, so the server turns it away.
public let protocolVersion = 2

/// A friend request waiting on you, with the challenge you share; declined ones never show.
public struct IncomingRequest: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var challengeId: String
}

/// The signed-in profile, as /api/sync, /api/profile and every sign-in return it. Each editable
/// field is its own last-writer-wins register with its own clock.
public struct Account: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var nameUpdatedAt: Int64?
    /// Nil means DayCalendar.defaultTimeZoneIdentifier: the account predates zones.
    public var timeZone: String?
    public var zoneUpdatedAt: Int64?
    /// Nil until first set; each device then falls back to its own goal.
    public var dailyGoalReps: Int?
    public var goalUpdatedAt: Int64?
    /// Sent with /api/sync only.
    public var incomingRequests: [IncomingRequest]?

    public init(id: String, name: String, nameUpdatedAt: Int64? = nil, timeZone: String? = nil, zoneUpdatedAt: Int64? = nil, dailyGoalReps: Int? = nil, goalUpdatedAt: Int64? = nil, incomingRequests: [IncomingRequest]? = nil) {
        self.id = id
        self.name = name
        self.nameUpdatedAt = nameUpdatedAt
        self.timeZone = timeZone
        self.zoneUpdatedAt = zoneUpdatedAt
        self.dailyGoalReps = dailyGoalReps
        self.goalUpdatedAt = goalUpdatedAt
        self.incomingRequests = incomingRequests
    }
}

/// POST /api/profile. Every value comes with its clock.
public struct ProfilePatch: Codable, Hashable, Sendable {
    public var name: String?
    public var nameUpdatedAt: Int64?
    public var timeZone: String?
    public var zoneUpdatedAt: Int64?
    public var dailyGoalReps: Int?
    public var goalUpdatedAt: Int64?

    public init() {}

    public var isEmpty: Bool { nameUpdatedAt == nil && zoneUpdatedAt == nil && goalUpdatedAt == nil }

    /// What is still unsent once `sent` is acknowledged: a field edited again since keeps its newer edit.
    func remaining(afterAcknowledging sent: ProfilePatch) -> ProfilePatch {
        var remaining = self
        if remaining.nameUpdatedAt == sent.nameUpdatedAt {
            remaining.name = nil
            remaining.nameUpdatedAt = nil
        }
        if remaining.zoneUpdatedAt == sent.zoneUpdatedAt {
            remaining.timeZone = nil
            remaining.zoneUpdatedAt = nil
        }
        if remaining.goalUpdatedAt == sent.goalUpdatedAt {
            remaining.dailyGoalReps = nil
            remaining.goalUpdatedAt = nil
        }
        return remaining
    }
}

/// POST /api/sync.
public struct SyncRequest: Codable, Hashable, Sendable {
    public var protocolVersion: Int
    public var pushedEntries: [Entry]
    /// Merged before the entries, so an entry can log to a definition pushed alongside it.
    public var pushedDefinitions: [Definition]
    /// The cursor from the previous response; 0 pulls everything.
    public var sinceCursor: Int64
}

public struct SyncResponse: Codable, Hashable, Sendable {
    /// Entries written since `sinceCursor`, possibly a few already seen; merging them again is a no-op.
    public var entries: [Entry]
    /// Every created definition this account has adopted, plus any the returned entries point at.
    public var definitions: [Definition]?
    public var cursor: Int64
    public var account: Account

    public init(entries: [Entry], definitions: [Definition]? = nil, cursor: Int64, account: Account) {
        self.entries = entries
        self.definitions = definitions
        self.cursor = cursor
        self.account = account
    }
}

/// A non-2xx response, with the server's `error` message when it sent one.
public struct HTTPError: Error, Hashable, Sendable {
    public var status: Int
    public var message: String

    public init(status: Int, message: String) {
        self.status = status
        self.message = message
    }
}
