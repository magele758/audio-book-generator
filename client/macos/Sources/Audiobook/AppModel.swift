import AudiobookCore
import Foundation

enum Focus: Equatable {
    case none
    case chapter(bookID: String, chapterID: String)
    case playing(Playing)

    var anchor: Anchor? {
        switch self {
        case .none:
            nil
        case let .chapter(bookID, chapterID):
            Anchor(bookID: bookID, chapterID: chapterID, segmentID: nil)
        case let .playing(playing):
            Anchor(playing)
        }
    }

    var bookID: String? {
        switch self {
        case .none:
            nil
        case let .chapter(bookID, _):
            bookID
        case let .playing(playing):
            playing.bookID
        }
    }
}

enum PlaybackRate: Double, CaseIterable, Identifiable {
    case slow = 0.8
    case normal = 1
    case quick = 1.25
    case faster = 1.5
    case fast = 1.75
    case fastest = 2

    var id: Double { rawValue }
    var label: String { String(format: "%g", rawValue) }
}

enum SleepChoice: String, CaseIterable, Identifiable {
    case off
    case quarter
    case half
    case chapter

    var id: String { rawValue }

    var title: String {
        switch self {
        case .off: "关"
        case .quarter: "15 分钟"
        case .half: "30 分钟"
        case .chapter: "本章结束"
        }
    }
}

struct PickedFile: Sendable {
    var name: String
    var data: Data
}

@MainActor
final class AppModel: ObservableObject {
    @Published var serverBase = "http://127.0.0.1:4173"
    @Published var books: [Book] = []
    @Published var focus: Focus = .none
    @Published var isPlaying = false
    @Published var statusLine = "正在连接本机服务…"
    @Published var isBusy = false
    @Published var ttsBaseURL = ""
    @Published var ttsLang = "ZH"
    @Published var durationFactor = 1.0
    @Published var voiceConfigured = false
    @Published var voiceName = ""
    @Published var pageURL = ""
    @Published var speed: PlaybackRate = .normal
    @Published var sleepChoice: SleepChoice = .off

    private let session = ServerAPI.makeSession()
    private let clip = ClipPlayer()
    private let preview = PreviewSpeaker()
    private var sleepTask: Task<Void, Never>?
    private var libraryEpoch = 0
    private var ttsDirty = false
    private var appliedBase = ""
    private var appliedLang = "ZH"
    private var appliedFactor = 1.0

    init() {
        clip.onEnded = { [weak self] in
            self?.clipEnded()
        }
        clip.onFailed = { [weak self] message in
            self?.isPlaying = false
            self?.statusLine = message
        }
        Task { [weak self] in
            await self?.refreshNow()
        }
    }

    var nowPlayingText: String {
        guard let anchor = focus.anchor,
              let ref = Playlist.lookup(books: books, bookID: anchor.bookID, chapterID: anchor.chapterID) else {
            return "未选择章节"
        }
        guard let segmentID = anchor.segmentID,
              let ordinal = Playlist.ordinal(of: segmentID, in: ref.chapter) else {
            return "\(ref.book.title) · \(ref.chapter.title)"
        }
        return "\(ref.book.title) · \(ref.chapter.title) · 第 \(ordinal.number) / \(ordinal.count) 段"
    }

    var focusedRef: ChapterRef? {
        guard let anchor = focus.anchor else { return nil }
        return Playlist.lookup(books: books, bookID: anchor.bookID, chapterID: anchor.chapterID)
    }

    var playingSegmentID: String? {
        if case let .playing(playing) = focus { return playing.segmentID }
        return nil
    }

    var clockText: String { clip.clockText }

    var voiceLine: String {
        if voiceConfigured {
            return voiceName.isEmpty ? "已上传音色样本" : "已上传音色样本：\(voiceName)"
        }
        return "还没有音色样本"
    }

    func noteTtsEdit() {
        ttsDirty = ttsBaseURL != appliedBase
            || ttsLang != appliedLang
            || abs(durationFactor - appliedFactor) > 0.000_1
    }

    func applySpeed() {
        clip.setRate(Float(speed.rawValue))
    }

    func refresh() {
        run("正在刷新资料库…") {
            let epoch = self.beginLibraryFetch()
            let snapshot = try await self.tryAPI().library()
            guard epoch == self.libraryEpoch else { return }
            self.adopt(snapshot)
            self.statusLine = self.books.isEmpty ? "资料库是空的。" : "已刷新资料库。"
        }
    }

    func select(book: Book, chapter: Chapter) {
        if let segment = Playlist.firstReady(in: chapter) {
            start(Playing(bookID: book.id, chapterID: chapter.id, segmentID: segment.id), autoplay: true)
        } else {
            preview.stop()
            clip.pause()
            isPlaying = false
            focus = .chapter(bookID: book.id, chapterID: chapter.id)
            statusLine = "这一章还没有可播放的片段。"
        }
    }

    func playSegment(_ segment: Segment, chapter: Chapter, book: Book) {
        guard segment.audio.status == .ready else { return }
        start(Playing(bookID: book.id, chapterID: chapter.id, segmentID: segment.id), autoplay: true)
    }

    func togglePlay() {
        if isPlaying {
            clip.pause()
            isPlaying = false
            return
        }
        if case .playing = focus {
            preview.stop()
            clip.resume()
            isPlaying = true
            return
        }
        guard let ref = focusedRef, let segment = Playlist.firstReady(in: ref.chapter) else {
            statusLine = "这一章还没有可播放的片段。"
            return
        }
        start(Playing(bookID: ref.book.id, chapterID: ref.chapter.id, segmentID: segment.id), autoplay: true)
    }

    func previousSegment() {
        guard let anchor = focus.anchor else {
            statusLine = "还没有选中章节"
            return
        }
        guard let playing = Playlist.previousReady(in: books, before: anchor) else {
            statusLine = "已经是第一段"
            return
        }
        start(playing, autoplay: true)
    }

    func nextSegment() {
        guard let anchor = focus.anchor else {
            statusLine = "还没有选中章节"
            return
        }
        guard let playing = Playlist.nextReady(in: books, after: anchor) else {
            statusLine = "已经是最后一段"
            return
        }
        start(playing, autoplay: true)
    }

    func previousChapter() {
        jump(.previous)
    }

    func nextChapter() {
        jump(.next)
    }

    func chooseSleep(_ choice: SleepChoice) {
        sleepTask?.cancel()
        sleepTask = nil
        sleepChoice = choice
        switch choice {
        case .off:
            statusLine = "睡眠已关闭"
        case .quarter:
            armMinutes(15)
        case .half:
            armMinutes(30)
        case .chapter:
            statusLine = "将在本章结束后暂停"
        }
    }

    func saveConfiguration() {
        run("正在保存 Index-TTS 配置…") {
            try await self.saveTts()
            self.statusLine = "Index-TTS 配置已保存。"
        }
    }

    func testConnection() {
        run("正在测试 Index-TTS 连接…") {
            try await self.saveTts()
            try await self.tryAPI().testConnection()
            self.statusLine = "Index-TTS 已连通，服务里有 /gen_single。"
        }
    }

    func previewSentence() {
        run("正在用当前音色试听一句…") {
            try await self.saveTts()
            let wav = try await self.tryAPI().preview(text: "这是 Index-TTS 的音色试听。")
            self.clip.pause()
            self.isPlaying = false
            try self.preview.play(data: wav)
            self.statusLine = "正在试听音色。"
        }
    }

    func generate() {
        guard let bookID = focus.bookID else {
            statusLine = "先在左侧选择一本书"
            return
        }
        run("正在生成本书的段落音频…") {
            let book = try await self.tryAPI().generateBook(id: bookID)
            self.install(book)
            let failed = Playlist.failedCount(book)
            self.statusLine = failed > 0 ? "\(failed) 段生成失败，可以重试。" : "段落片段已写入资料库。"
            await self.pullLibrary()
        }
    }

    func importPDF(_ result: Result<URL, Error>) {
        guard let file = takeFile(result) else { return }
        guard !file.data.isEmpty else {
            statusLine = "PDF 文件是空的。"
            return
        }
        run("正在导入 PDF…") {
            let book = try await self.tryAPI().importPDF(filename: file.name, bytes: file.data)
            await self.finishImport(book)
        }
    }

    func importHTML(_ result: Result<URL, Error>) {
        guard let file = takeFile(result) else { return }
        guard let html = String(data: file.data, encoding: .utf8) else {
            statusLine = "HTML 需要是 UTF-8 文本。"
            return
        }
        guard !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            statusLine = "HTML 文件是空的。"
            return
        }
        run("正在导入网页…") {
            let book = try await self.tryAPI().importHTML(filename: file.name, html: html)
            await self.finishImport(book)
        }
    }

    func importPage() {
        let url = pageURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else {
            statusLine = "请填写网页 URL。"
            return
        }
        run("正在抓取网页…") {
            let book = try await self.tryAPI().importWeb(url: url)
            await self.finishImport(book)
        }
    }

    func uploadVoice(_ result: Result<URL, Error>) {
        guard let file = takeFile(result) else { return }
        guard !file.data.isEmpty else {
            statusLine = "wav 文件是空的。"
            return
        }
        run("正在上传音色样本…") {
            try await self.saveTts()
            let settings = try await self.tryAPI().uploadVoice(filename: file.name, wav: file.data)
            self.applySaved(settings)
            let name = settings.voiceName.isEmpty ? file.name : settings.voiceName
            self.statusLine = "音色样本已上传：\(name)"
        }
    }

    private func refreshNow() async {
        let epoch = beginLibraryFetch()
        do {
            let snapshot = try await tryAPI().library()
            guard epoch == libraryEpoch else { return }
            adopt(snapshot)
            statusLine = books.isEmpty ? "资料库是空的。可以在下面导入 PDF 或网页。" : "已刷新资料库。"
        } catch {
            guard epoch == libraryEpoch else { return }
            statusLine = (error as? ServerFailure)?.message ?? error.localizedDescription
        }
    }

    private func pullLibrary() async {
        let epoch = beginLibraryFetch()
        guard let snapshot = try? await tryAPI().library() else { return }
        // A slower library response must not overwrite a newer one.
        guard epoch == libraryEpoch else { return }
        adopt(snapshot)
    }

    private func beginLibraryFetch() -> Int {
        libraryEpoch += 1
        return libraryEpoch
    }

    private func finishImport(_ book: Book) async {
        install(book)
        if let chapter = Playlist.chapters(in: book).first {
            focus = .chapter(bookID: book.id, chapterID: chapter.id)
        }
        statusLine = "已导入《\(book.title)》，共 \(book.chapters.count) 章。"
        await pullLibrary()
    }

    private func saveTts() async throws {
        let settings = try await tryAPI().saveTts(
            baseURL: ttsBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
            lang: ttsLang,
            durationFactor: durationFactor
        )
        applySaved(settings)
    }

    private func applySaved(_ settings: TtsSettings) {
        ttsBaseURL = settings.baseUrl
        if TtsLang.isKnown(settings.lang) {
            ttsLang = settings.lang
        }
        durationFactor = settings.durationFactor
        voiceName = settings.voiceName
        voiceConfigured = settings.voiceConfigured
        appliedBase = ttsBaseURL
        appliedLang = ttsLang
        appliedFactor = durationFactor
        ttsDirty = false
    }

    private func adopt(_ snapshot: LibrarySnapshot) {
        books = snapshot.books
        voiceConfigured = snapshot.voiceConfigured || snapshot.tts.voiceConfigured
        voiceName = snapshot.tts.voiceName
        if !ttsDirty {
            ttsBaseURL = snapshot.tts.baseUrl
            if TtsLang.isKnown(snapshot.tts.lang) {
                ttsLang = snapshot.tts.lang
            }
            durationFactor = snapshot.tts.durationFactor
            appliedBase = ttsBaseURL
            appliedLang = ttsLang
            appliedFactor = durationFactor
        }
        reconcileFocus()
    }

    private func install(_ book: Book) {
        if let index = books.firstIndex(where: { $0.id == book.id }) {
            books[index] = book
        } else {
            books.append(book)
        }
        reconcileFocus()
    }

    private func reconcileFocus() {
        switch focus {
        case .none:
            break
        case let .chapter(bookID, chapterID):
            if Playlist.lookup(books: books, bookID: bookID, chapterID: chapterID) == nil {
                focus = .none
            }
        case let .playing(playing):
            guard Playlist.locate(books, playing) == nil else { return }
            if Playlist.lookup(books: books, bookID: playing.bookID, chapterID: playing.chapterID) != nil {
                focus = .chapter(bookID: playing.bookID, chapterID: playing.chapterID)
            } else {
                focus = .none
            }
            clip.pause()
            isPlaying = false
        }
    }

    private func start(_ playing: Playing, autoplay: Bool) {
        preview.stop()
        guard let url = try? tryAPI().audioURL(
            bookID: playing.bookID,
            chapterID: playing.chapterID,
            segmentID: playing.segmentID
        ) else {
            statusLine = "服务地址无效"
            return
        }
        focus = .playing(playing)
        if autoplay {
            clip.play(url: url, rate: Float(speed.rawValue))
            isPlaying = true
        } else {
            clip.stage(url: url, rate: Float(speed.rawValue))
            isPlaying = false
        }
        showTransportStatus()
    }

    private func jump(_ direction: ChapterDirection) {
        guard let anchor = focus.anchor else {
            statusLine = "还没有选中章节"
            return
        }
        switch Playlist.stepChapter(in: books, from: anchor, direction: direction) {
        case .missing:
            statusLine = direction == .next ? "已经是最后一章" : "已经是第一章"
        case let .ready(playing):
            start(playing, autoplay: true)
        case let .idle(bookID, chapterID):
            preview.stop()
            clip.pause()
            isPlaying = false
            focus = .chapter(bookID: bookID, chapterID: chapterID)
            statusLine = "这一章还没有可播放的片段。"
        }
    }

    private func clipEnded() {
        guard case let .playing(current) = focus else { return }
        if sleepChoice == .chapter, Playlist.isLastReadyInChapter(books, playing: current) {
            pauseForSleep("本章已结束，已暂停")
            return
        }
        guard let next = Playlist.nextReady(in: books, after: Anchor(current)) else {
            isPlaying = false
            statusLine = "已播放到末尾"
            return
        }
        start(next, autoplay: true)
    }

    private func armMinutes(_ minutes: Int) {
        statusLine = "将在 \(minutes) 分钟后暂停"
        sleepTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(minutes) * 60 * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.pauseForSleep("定时已到，已暂停")
        }
    }

    private func pauseForSleep(_ message: String) {
        sleepTask?.cancel()
        sleepTask = nil
        sleepChoice = .off
        clip.pause()
        preview.stop()
        isPlaying = false
        statusLine = message
    }

    private func showTransportStatus() {
        switch sleepChoice {
        case .off:
            statusLine = ""
        case .quarter:
            statusLine = "将在 15 分钟后暂停"
        case .half:
            statusLine = "将在 30 分钟后暂停"
        case .chapter:
            statusLine = "将在本章结束后暂停"
        }
    }

    private func tryAPI() throws -> ServerAPI {
        guard let api = ServerAPI(baseURLString: serverBase, session: session) else {
            throw ServerFailure(message: "服务地址无效")
        }
        return api
    }

    private func run(_ label: String, work: @escaping @MainActor () async throws -> Void) {
        guard !isBusy else {
            statusLine = "正在处理，请稍候。"
            return
        }
        isBusy = true
        statusLine = label
        Task { @MainActor in
            do {
                try await work()
            } catch {
                self.statusLine = (error as? ServerFailure)?.message ?? error.localizedDescription
            }
            self.isBusy = false
        }
    }

    private func takeFile(_ result: Result<URL, Error>) -> PickedFile? {
        switch result {
        case let .failure(error):
            statusLine = error.localizedDescription
            return nil
        case let .success(url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url)
                return PickedFile(name: url.lastPathComponent, data: data)
            } catch {
                statusLine = error.localizedDescription
                return nil
            }
        }
    }
}
