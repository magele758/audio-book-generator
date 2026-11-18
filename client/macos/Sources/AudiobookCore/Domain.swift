import Foundation

public enum AudioStatus: Equatable, Hashable, Sendable {
    case pending
    case ready
    case failed
    case unknown(String)
}

extension AudioStatus: Decodable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "pending":
            self = .pending
        case "ready":
            self = .ready
        case "failed":
            self = .failed
        default:
            self = .unknown(raw)
        }
    }
}

public struct SegmentAudio: Equatable, Hashable, Decodable, Sendable {
    public var status: AudioStatus
    public var bytes: Int
    public var error: String?

    public init(status: AudioStatus, bytes: Int = 0, error: String? = nil) {
        self.status = status
        self.bytes = bytes
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decodeIfPresent(AudioStatus.self, forKey: .status) ?? .pending
        bytes = try container.decodeIfPresent(Int.self, forKey: .bytes) ?? 0
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case bytes
        case error
    }
}

public struct Segment: Equatable, Hashable, Identifiable, Decodable, Sendable {
    public var id: String
    public var index: Int
    public var text: String
    public var audio: SegmentAudio

    public init(id: String, index: Int, text: String, audio: SegmentAudio) {
        self.id = id
        self.index = index
        self.text = text
        self.audio = audio
    }
}

public struct Chapter: Equatable, Hashable, Identifiable, Decodable, Sendable {
    public var id: String
    public var index: Int
    public var title: String
    public var text: String
    public var preview: String
    public var segments: [Segment]

    public init(
        id: String,
        index: Int,
        title: String,
        text: String = "",
        preview: String = "",
        segments: [Segment]
    ) {
        self.id = id
        self.index = index
        self.title = title
        self.text = text
        self.preview = preview
        self.segments = segments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        index = try container.decodeIfPresent(Int.self, forKey: .index) ?? 0
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        preview = try container.decodeIfPresent(String.self, forKey: .preview) ?? ""
        segments = try container.decodeIfPresent([Segment].self, forKey: .segments) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case index
        case title
        case text
        case preview
        case segments
    }
}

public struct BookSource: Equatable, Hashable, Decodable, Sendable {
    public var kind: String
    public var label: String

    public init(kind: String, label: String) {
        self.kind = kind
        self.label = label
    }
}

public struct Book: Equatable, Hashable, Identifiable, Decodable, Sendable {
    public var id: String
    public var title: String
    public var source: BookSource?
    public var chapters: [Chapter]

    public init(id: String, title: String, source: BookSource? = nil, chapters: [Chapter]) {
        self.id = id
        self.title = title
        self.source = source
        self.chapters = chapters
    }
}

public struct TtsSettings: Equatable, Hashable, Decodable, Sendable {
    public var baseUrl: String
    public var lang: String
    public var durationFactor: Double
    public var voiceName: String
    public var voiceConfigured: Bool

    public init(
        baseUrl: String,
        lang: String,
        durationFactor: Double,
        voiceName: String,
        voiceConfigured: Bool
    ) {
        self.baseUrl = baseUrl
        self.lang = lang
        self.durationFactor = durationFactor
        self.voiceName = voiceName
        self.voiceConfigured = voiceConfigured
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        lang = try container.decodeIfPresent(String.self, forKey: .lang) ?? "ZH"
        durationFactor = try container.decodeIfPresent(Double.self, forKey: .durationFactor) ?? 1
        voiceName = try container.decodeIfPresent(String.self, forKey: .voiceName) ?? ""
        voiceConfigured = try container.decodeIfPresent(Bool.self, forKey: .voiceConfigured) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case baseUrl
        case lang
        case durationFactor
        case voiceName
        case voiceConfigured
    }
}

public struct LibrarySnapshot: Equatable, Decodable, Sendable {
    public var books: [Book]
    public var voiceConfigured: Bool
    public var tts: TtsSettings

    public init(books: [Book], voiceConfigured: Bool, tts: TtsSettings) {
        self.books = books
        self.voiceConfigured = voiceConfigured
        self.tts = tts
    }
}

public struct Playing: Equatable, Hashable, Sendable {
    public var bookID: String
    public var chapterID: String
    public var segmentID: String

    public init(bookID: String, chapterID: String, segmentID: String) {
        self.bookID = bookID
        self.chapterID = chapterID
        self.segmentID = segmentID
    }
}

public struct Anchor: Equatable, Hashable, Sendable {
    public var bookID: String
    public var chapterID: String
    public var segmentID: String?

    public init(bookID: String, chapterID: String, segmentID: String?) {
        self.bookID = bookID
        self.chapterID = chapterID
        self.segmentID = segmentID
    }

    public init(_ playing: Playing) {
        bookID = playing.bookID
        chapterID = playing.chapterID
        segmentID = playing.segmentID
    }
}

public struct ChapterRef: Equatable, Sendable {
    public var book: Book
    public var chapter: Chapter

    public init(book: Book, chapter: Chapter) {
        self.book = book
        self.chapter = chapter
    }
}

public enum ChapterDirection: Equatable, Sendable {
    case previous
    case next
}

public enum ChapterStep: Equatable, Sendable {
    case missing
    case ready(Playing)
    case idle(bookID: String, chapterID: String)
}

public enum TtsLang {
    public static let options = ["ZH", "EN", "JA", "AR", "ES"]

    public static func isKnown(_ value: String) -> Bool {
        options.contains(value)
    }
}
