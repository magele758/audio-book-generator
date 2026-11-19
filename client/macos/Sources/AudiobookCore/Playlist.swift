import Foundation

public enum Playlist {
    public static func chapters(in book: Book) -> [Chapter] {
        book.chapters.sorted { $0.index < $1.index }
    }

    public static func segments(in chapter: Chapter) -> [Segment] {
        chapter.segments.sorted { $0.index < $1.index }
    }

    public static func firstReady(in chapter: Chapter) -> Segment? {
        segments(in: chapter).first { $0.audio.status == .ready }
    }

    public static func readyCount(in chapter: Chapter) -> Int {
        segments(in: chapter).filter { $0.audio.status == .ready }.count
    }

    public static func failedCount(_ book: Book) -> Int {
        chapters(in: book).reduce(0) { count, chapter in
            count + segments(in: chapter).filter { $0.audio.status == .failed }.count
        }
    }

    public static func lookup(books: [Book], bookID: String, chapterID: String) -> ChapterRef? {
        guard let book = books.first(where: { $0.id == bookID }),
              let chapter = chapters(in: book).first(where: { $0.id == chapterID }) else {
            return nil
        }
        return ChapterRef(book: book, chapter: chapter)
    }

    public static func locate(_ books: [Book], _ playing: Playing) -> ChapterRef? {
        guard let ref = lookup(books: books, bookID: playing.bookID, chapterID: playing.chapterID),
              segments(in: ref.chapter).contains(where: { $0.id == playing.segmentID }) else {
            return nil
        }
        return ref
    }

    public static func ordinal(of segmentID: String, in chapter: Chapter) -> (number: Int, count: Int)? {
        let ordered = segments(in: chapter)
        guard let index = ordered.firstIndex(where: { $0.id == segmentID }) else { return nil }
        return (index + 1, ordered.count)
    }

    public static func nextReady(in books: [Book], after anchor: Anchor) -> Playing? {
        guard let book = books.first(where: { $0.id == anchor.bookID }) else { return nil }
        let orderedChapters = chapters(in: book)
        guard let chapterIndex = orderedChapters.firstIndex(where: { $0.id == anchor.chapterID }) else {
            return nil
        }
        let orderedSegments = segments(in: orderedChapters[chapterIndex])
        let start: Int
        if let segmentID = anchor.segmentID,
           let segmentIndex = orderedSegments.firstIndex(where: { $0.id == segmentID }) {
            start = segmentIndex + 1
        } else {
            start = 0
        }
        if let segment = orderedSegments.dropFirst(start).first(where: { $0.audio.status == .ready }) {
            return Playing(bookID: book.id, chapterID: orderedChapters[chapterIndex].id, segmentID: segment.id)
        }
        for chapter in orderedChapters.dropFirst(chapterIndex + 1) {
            if let segment = firstReady(in: chapter) {
                return Playing(bookID: book.id, chapterID: chapter.id, segmentID: segment.id)
            }
        }
        return nil
    }

    public static func previousReady(in books: [Book], before anchor: Anchor) -> Playing? {
        guard let book = books.first(where: { $0.id == anchor.bookID }) else { return nil }
        let orderedChapters = chapters(in: book)
        guard let chapterIndex = orderedChapters.firstIndex(where: { $0.id == anchor.chapterID }) else {
            return nil
        }
        let orderedSegments = segments(in: orderedChapters[chapterIndex])
        if let segmentID = anchor.segmentID,
           let segmentIndex = orderedSegments.firstIndex(where: { $0.id == segmentID }),
           let earlier = orderedSegments.prefix(segmentIndex).last(where: { $0.audio.status == .ready }) {
            return Playing(bookID: book.id, chapterID: orderedChapters[chapterIndex].id, segmentID: earlier.id)
        }
        for chapter in orderedChapters.prefix(chapterIndex).reversed() {
            if let segment = segments(in: chapter).last(where: { $0.audio.status == .ready }) {
                return Playing(bookID: book.id, chapterID: chapter.id, segmentID: segment.id)
            }
        }
        return nil
    }

    public static func isLastReadyInChapter(_ books: [Book], playing: Playing) -> Bool {
        guard let ref = locate(books, playing) else { return false }
        let ordered = segments(in: ref.chapter)
        guard let index = ordered.firstIndex(where: { $0.id == playing.segmentID }) else { return false }
        return !ordered.dropFirst(index + 1).contains { $0.audio.status == .ready }
    }

    public static func stepChapter(
        in books: [Book],
        from anchor: Anchor,
        direction: ChapterDirection
    ) -> ChapterStep {
        guard let book = books.first(where: { $0.id == anchor.bookID }) else { return .missing }
        let ordered = chapters(in: book)
        guard let chapterIndex = ordered.firstIndex(where: { $0.id == anchor.chapterID }) else {
            return .missing
        }
        let offset = direction == .next ? 1 : -1
        let nextIndex = chapterIndex + offset
        guard ordered.indices.contains(nextIndex) else { return .missing }
        let chapter = ordered[nextIndex]
        if let segment = firstReady(in: chapter) {
            return .ready(Playing(bookID: book.id, chapterID: chapter.id, segmentID: segment.id))
        }
        return .idle(bookID: book.id, chapterID: chapter.id)
    }
}
