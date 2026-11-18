import Foundation

public enum SelfCheck {
    public static func run() -> [String] {
        var failures: [String] = []
        func expect(_ condition: Bool, _ message: String) {
            if !condition { failures.append(message) }
        }

        expect(
            ServerAPI.failureMessage(data: Data(#"{"error":"先上传音色样本"}"#.utf8), status: 400) == "先上传音色样本",
            "json error is the status line"
        )
        expect(
            ServerAPI.failureMessage(data: Data("nope".utf8), status: 500) == "请求失败（HTTP 500）",
            "non-json error falls back to HTTP status"
        )

        do {
            let response = try http(status: 404, type: "application/json")
            _ = try ServerAPI.interpret(data: Data(#"{"error":"segment not found"}"#.utf8), response: response)
            failures.append("error response was treated as success")
        } catch let failure as ServerFailure {
            expect(failure.message == "segment not found", "404 message was \(failure.message)")
        } catch {
            failures.append("unexpected interpret error \(error)")
        }

        do {
            let response = try http(status: 200, type: "audio/wav")
            let data = Data("RIFFdemo".utf8)
            let payload = try ServerAPI.interpret(data: data, response: response)
            expect(payload == .audio(data), "wav response was not audio")
        } catch {
            failures.append("wav interpret threw \(error)")
        }

        do {
            _ = try ServerAPI.audioData(from: .json(Data(#"{"error":"先填写 Index-TTS 地址"}"#.utf8)))
            failures.append("preview json error was ignored")
        } catch let failure as ServerFailure {
            expect(failure.message == "先填写 Index-TTS 地址", "preview message was \(failure.message)")
        } catch {
            failures.append("unexpected preview error \(error)")
        }

        do {
            let snapshot = try JSONDecoder().decode(LibrarySnapshot.self, from: Data(libraryJSON.utf8))
            expect(snapshot.books.count == 1, "book count")
            expect(snapshot.tts.durationFactor == 1, "duration factor")
            expect(snapshot.tts.lang == "ZH", "lang")
            expect(snapshot.voiceConfigured == false, "voice flag")
            let first = Playlist.chapters(in: snapshot.books[0])[0]
            expect(first.title == "前章", "chapters sort by index")
            expect(
                first.segments.map(\.audio.status) == [.pending, .ready, .unknown("later")],
                "segment statuses"
            )
            expect(first.segments[0].audio.error == nil, "null error")
            expect(Playlist.firstReady(in: first)?.id == "s1", "first ready skips pending")
        } catch {
            failures.append("library json \(error)")
        }

        let book = sampleBook()
        let books = [book]
        expect(Playlist.firstReady(in: Playlist.chapters(in: book)[0])?.id == "ready-a", "first ready in index order")
        let afterPending = Playlist.nextReady(
            in: books,
            after: Anchor(bookID: "book", chapterID: "early", segmentID: "pending-a")
        )
        expect(afterPending?.segmentID == "ready-a", "next skips pending")
        let across = Playlist.nextReady(
            in: books,
            after: Anchor(Playing(bookID: "book", chapterID: "early", segmentID: "ready-a"))
        )
        expect(across?.chapterID == "later" && across?.segmentID == "ready-b", "next skips a chapter with no ready audio")
        if let across {
            let back = Playlist.previousReady(in: books, before: Anchor(across))
            expect(back?.segmentID == "ready-a", "previous returns to the prior ready segment")
        }
        expect(
            Playlist.isLastReadyInChapter(books, playing: Playing(bookID: "book", chapterID: "early", segmentID: "ready-a")),
            "last ready ignores later failed audio"
        )
        expect(
            !Playlist.isLastReadyInChapter(books, playing: Playing(bookID: "book", chapterID: "later", segmentID: "ready-b")),
            "a later ready segment keeps the chapter open"
        )
        let fromEarly = Anchor(bookID: "book", chapterID: "early", segmentID: "ready-a")
        expect(
            Playlist.stepChapter(in: books, from: fromEarly, direction: .next) == .idle(bookID: "book", chapterID: "middle"),
            "next chapter lands on an unready chapter"
        )
        expect(
            Playlist.stepChapter(in: books, from: Anchor(bookID: "book", chapterID: "middle", segmentID: nil), direction: .next)
                == .ready(Playing(bookID: "book", chapterID: "later", segmentID: "ready-b")),
            "next chapter plays the first ready segment"
        )
        expect(Playlist.stepChapter(in: books, from: fromEarly, direction: .previous) == .missing, "no chapter before the first")

        let session = URLSession(configuration: .ephemeral)
        if let api = ServerAPI(baseURLString: "http://127.0.0.1:4173/", session: session) {
            expect(
                api.audioURL(bookID: "b", chapterID: "c", segmentID: "s").absoluteString
                    == "http://127.0.0.1:4173/api/books/b/chapters/c/segments/s/audio",
                "audio url was \(api.audioURL(bookID: "b", chapterID: "c", segmentID: "s").absoluteString)"
            )
        } else {
            failures.append("server url with trailing slash was rejected")
        }
        expect(ServerAPI(baseURLString: "not a url", session: session) == nil, "invalid server url")
        return failures
    }

    private static func http(status: Int, type: String) throws -> HTTPURLResponse {
        guard let response = HTTPURLResponse(
            url: URL(string: "http://127.0.0.1:4173/api/library")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": type]
        ) else {
            throw ServerFailure(message: "could not build response")
        }
        return response
    }

    private static func sampleBook() -> Book {
        Book(
            id: "book",
            title: "样例",
            chapters: [
                Chapter(id: "later", index: 2, title: "后", segments: [
                    segment("ready-b", 0, .ready),
                    segment("ready-c", 1, .ready),
                ]),
                Chapter(id: "middle", index: 1, title: "中", segments: [
                    segment("pending-b", 0, .pending),
                    segment("failed-b", 1, .failed),
                ]),
                Chapter(id: "early", index: 0, title: "前", segments: [
                    segment("pending-a", 0, .pending),
                    segment("ready-a", 1, .ready),
                    segment("failed-a", 2, .failed),
                ]),
            ]
        )
    }

    private static func segment(_ id: String, _ index: Int, _ status: AudioStatus) -> Segment {
        Segment(id: id, index: index, text: id, audio: SegmentAudio(status: status))
    }
}

private let libraryJSON = """
{
  "books": [
    {
      "id": "b1",
      "title": "样例",
      "source": { "kind": "pdf", "label": "a.pdf" },
      "chapters": [
        {
          "id": "c-later",
          "index": 1,
          "title": "后章",
          "text": "后",
          "preview": "后",
          "segments": []
        },
        {
          "id": "c-early",
          "index": 0,
          "title": "前章",
          "text": "前",
          "preview": "前",
          "segments": [
            {
              "id": "s0",
              "index": 0,
              "text": "待",
              "audio": { "status": "pending", "bytes": 0, "error": null }
            },
            {
              "id": "s1",
              "index": 1,
              "text": "好",
              "audio": { "status": "ready", "bytes": 4, "error": null }
            },
            {
              "id": "s2",
              "index": 2,
              "text": "新",
              "audio": { "status": "later", "bytes": 0, "error": "x" }
            }
          ]
        }
      ]
    }
  ],
  "voiceConfigured": false,
  "tts": {
    "baseUrl": "http://tts",
    "lang": "ZH",
    "durationFactor": 1,
    "voiceName": "",
    "voiceConfigured": false
  }
}
"""
