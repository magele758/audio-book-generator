import Foundation

public struct ServerFailure: Error, Equatable, LocalizedError, Sendable {
    public var message: String

    public init(message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

public enum ServerPayload: Equatable, Sendable {
    case json(Data)
    case audio(Data)
}

public struct ServerAPI: Sendable {
    public var root: URL
    public var session: URLSession

    public init?(baseURLString: String, session: URLSession) {
        var trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.count > "https://".count && trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil else {
            return nil
        }
        root = url
        self.session = session
    }

    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3600
        configuration.timeoutIntervalForResource = 3600
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    public func audioURL(bookID: String, chapterID: String, segmentID: String) -> URL {
        endpoint(["api", "books", bookID, "chapters", chapterID, "segments", segmentID, "audio"])
    }

    public func library() async throws -> LibrarySnapshot {
        let data = try await send(path: ["api", "library"], method: "GET", body: nil, timeout: 30)
        do {
            return try JSONDecoder().decode(LibrarySnapshot.self, from: data)
        } catch {
            throw ServerFailure(message: "资料库数据无法解析")
        }
    }

    public func importPDF(filename: String, bytes: Data) async throws -> Book {
        let body = ImportPDF(kind: "pdf", filename: filename, pdfBase64: bytes.base64EncodedString())
        return try await importBook(body, timeout: 180)
    }

    public func importHTML(filename: String, html: String) async throws -> Book {
        let body = ImportHTML(kind: "web", filename: filename, html: html)
        return try await importBook(body, timeout: 180)
    }

    public func importWeb(url: String) async throws -> Book {
        let body = ImportURL(kind: "web", url: url)
        return try await importBook(body, timeout: 180)
    }

    public func saveTts(baseURL: String, lang: String, durationFactor: Double) async throws -> TtsSettings {
        let body = TtsBody(baseUrl: baseURL, lang: lang, durationFactor: durationFactor)
        return try await ttsSettings(path: ["api", "tts"], body: body, timeout: 30)
    }

    public func uploadVoice(filename: String, wav: Data) async throws -> TtsSettings {
        let body = VoiceBody(wavBase64: wav.base64EncodedString(), filename: filename)
        return try await ttsSettings(path: ["api", "voice"], body: body, timeout: 180)
    }

    public func testConnection() async throws {
        let data = try await send(path: ["api", "tts", "test"], method: "POST", body: Data("{}".utf8), timeout: 60)
        if let message = Self.explicitError(in: data) {
            throw ServerFailure(message: message)
        }
    }

    public func preview(text: String) async throws -> Data {
        let body = PreviewBody(text: text)
        let encoded = try JSONEncoder().encode(body)
        let (data, response) = try await perform(
            path: ["api", "tts", "preview"],
            method: "POST",
            body: encoded,
            timeout: 180
        )
        return try Self.audioData(from: try Self.interpret(data: data, response: response))
    }

    public func generateBook(id: String) async throws -> Book {
        let data = try await send(
            path: ["api", "books", id, "generate"],
            method: "POST",
            body: Data("{}".utf8),
            timeout: 3600
        )
        return try Self.book(from: data)
    }

    static func interpret(data: Data, response: URLResponse) throws -> ServerPayload {
        guard let http = response as? HTTPURLResponse else {
            throw ServerFailure(message: "没有 HTTP 响应")
        }
        if !(200 ... 299).contains(http.statusCode) {
            throw ServerFailure(message: failureMessage(data: data, status: http.statusCode))
        }
        let type = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        if type.contains("audio") || type.contains("wav") {
            return .audio(data)
        }
        return .json(data)
    }

    static func failureMessage(data: Data, status: Int) -> String {
        if let message = explicitError(in: data) {
            return message
        }
        return "请求失败（HTTP \(status)）"
    }

    static func audioData(from payload: ServerPayload) throws -> Data {
        switch payload {
        case .audio(let data):
            if data.isEmpty {
                throw ServerFailure(message: "试听没有返回音频")
            }
            return data
        case .json(let data):
            if let message = explicitError(in: data) {
                throw ServerFailure(message: message)
            }
            throw ServerFailure(message: "试听没有返回音频")
        }
    }

    private func importBook<T: Encodable>(_ body: T, timeout: TimeInterval) async throws -> Book {
        let encoded = try JSONEncoder().encode(body)
        let data = try await send(path: ["api", "import"], method: "POST", body: encoded, timeout: timeout)
        return try Self.book(from: data)
    }

    private func ttsSettings<T: Encodable>(path: [String], body: T, timeout: TimeInterval) async throws -> TtsSettings {
        let encoded = try JSONEncoder().encode(body)
        let data = try await send(path: path, method: "POST", body: encoded, timeout: timeout)
        let envelope = try JSONDecoder().decode(TtsEnvelope.self, from: data)
        var settings = envelope.tts
        if envelope.voiceConfigured == true {
            settings.voiceConfigured = true
        }
        return settings
    }

    private func send(path: [String], method: String, body: Data?, timeout: TimeInterval) async throws -> Data {
        let (data, response) = try await perform(path: path, method: method, body: body, timeout: timeout)
        switch try Self.interpret(data: data, response: response) {
        case .json(let json):
            return json
        case .audio:
            throw ServerFailure(message: "服务器返回了音频，而不是 JSON")
        }
    }

    private func perform(
        path: [String],
        method: String,
        body: Data?,
        timeout: TimeInterval
    ) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = method
        request.timeoutInterval = timeout
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            return try await session.data(for: request)
        } catch let failure as ServerFailure {
            throw failure
        } catch let urlError as URLError {
            switch urlError.code {
            case .timedOut:
                throw ServerFailure(message: "本机服务没有及时响应。")
            case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet:
                throw ServerFailure(message: "连不上本机服务。确认服务器已在这个地址启动。")
            default:
                throw ServerFailure(message: urlError.localizedDescription)
            }
        } catch {
            throw ServerFailure(message: error.localizedDescription)
        }
    }

    private func endpoint(_ parts: [String]) -> URL {
        parts.reduce(root) { partial, part in
            partial.appending(path: part)
        }
    }

    private static func book(from data: Data) throws -> Book {
        do {
            return try JSONDecoder().decode(BookEnvelope.self, from: data).book
        } catch {
            throw ServerFailure(message: "书籍数据无法解析")
        }
    }

    private static func explicitError(in data: Data) -> String? {
        guard let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) else { return nil }
        let message = envelope.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return message.isEmpty ? nil : message
    }
}

private struct ErrorEnvelope: Decodable {
    var error: String?
}

private struct BookEnvelope: Decodable {
    var book: Book
}

private struct TtsEnvelope: Decodable {
    var voiceConfigured: Bool?
    var tts: TtsSettings
}

private struct ImportPDF: Encodable {
    var kind: String
    var filename: String
    var pdfBase64: String
}

private struct ImportHTML: Encodable {
    var kind: String
    var filename: String
    var html: String
}

private struct ImportURL: Encodable {
    var kind: String
    var url: String
}

private struct TtsBody: Encodable {
    var baseUrl: String
    var lang: String
    var durationFactor: Double
}

private struct VoiceBody: Encodable {
    var wavBase64: String
    var filename: String
}

private struct PreviewBody: Encodable {
    var text: String
}
