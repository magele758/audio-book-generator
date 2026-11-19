import AudiobookCore
import SwiftUI
import UniformTypeIdentifiers

enum Palette {
    static let paper = Color(red: 0.965, green: 0.945, blue: 0.910)
    static let paperDeep = Color(red: 0.925, green: 0.895, blue: 0.845)
    static let ink = Color(red: 0.22, green: 0.16, blue: 0.12)
    static let inkSoft = Color(red: 0.43, green: 0.35, blue: 0.28)
    static let clay = Color(red: 0.58, green: 0.34, blue: 0.20)
    static let moss = Color(red: 0.27, green: 0.40, blue: 0.26)
    static let brick = Color(red: 0.62, green: 0.24, blue: 0.18)
    static let card = Color(red: 0.99, green: 0.975, blue: 0.955)
}

struct RootView: View {
    @ObservedObject var model: AppModel
    @State private var showPDF = false
    @State private var showHTML = false
    @State private var showWAV = false

    var body: some View {
        NavigationSplitView {
            LibrarySidebar(model: model)
                .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 360)
        } detail: {
            VStack(spacing: 0) {
                ChapterPane(model: model)
                Divider()
                PrepareForm(
                    model: model,
                    showPDF: $showPDF,
                    showHTML: $showHTML,
                    showWAV: $showWAV
                )
                .frame(maxHeight: 360)
            }
            .background(Palette.paper)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                TransportBar(model: model)
            }
        }
        .background(Palette.paper)
        .onChange(of: model.ttsBaseURL) { _, _ in model.noteTtsEdit() }
        .onChange(of: model.ttsLang) { _, _ in model.noteTtsEdit() }
        .onChange(of: model.durationFactor) { _, _ in model.noteTtsEdit() }
        .onChange(of: model.speed) { _, _ in model.applySpeed() }
        .fileImporter(isPresented: $showPDF, allowedContentTypes: [.pdf]) { result in
            model.importPDF(result)
        }
        .fileImporter(isPresented: $showHTML, allowedContentTypes: [.html]) { result in
            model.importHTML(result)
        }
        .fileImporter(isPresented: $showWAV, allowedContentTypes: [.wav, .audio]) { result in
            model.uploadVoice(result)
        }
    }
}

private struct LibrarySidebar: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("资料库")
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                Spacer()
                Button("刷新") { model.refresh() }
                    .disabled(model.isBusy)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 8)

            List {
                if model.books.isEmpty {
                    Text("还没有书")
                        .foregroundStyle(Palette.inkSoft)
                        .listRowBackground(Color.clear)
                }
                ForEach(model.books) { book in
                    Section {
                        ForEach(Playlist.chapters(in: book)) { chapter in
                            Button {
                                model.select(book: book, chapter: chapter)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(chapter.title.isEmpty ? "未命名章节" : chapter.title)
                                        .foregroundStyle(Palette.ink)
                                        .lineLimit(2)
                                    Text(chapterSummary(chapter))
                                        .font(.caption)
                                        .foregroundStyle(Palette.inkSoft)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 4)
                                .padding(.horizontal, 8)
                                .background(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(rowFill(chapter))
                                )
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                        }
                    } header: {
                        Text(book.title)
                            .font(.headline)
                            .foregroundStyle(Palette.ink)
                            .textCase(nil)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
        }
        .background(Palette.paperDeep)
    }

    private func chapterSummary(_ chapter: Chapter) -> String {
        let total = Playlist.segments(in: chapter).count
        let ready = Playlist.readyCount(in: chapter)
        return "\(ready)/\(total) 段已就绪"
    }

    private func rowFill(_ chapter: Chapter) -> Color {
        model.focus.anchor?.chapterID == chapter.id ? Palette.clay.opacity(0.16) : Color.clear
    }
}

private struct ChapterPane: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let ref = model.focusedRef {
                header(ref)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(Playlist.segments(in: ref.chapter)) { segment in
                            segmentRow(segment, chapter: ref.chapter, book: ref.book)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 16)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("从左侧选择章节")
                        .font(.title2)
                        .foregroundStyle(Palette.ink)
                    Text("有已就绪片段的章节会从第一段开始播放，然后继续后面的章节。")
                        .foregroundStyle(Palette.inkSoft)
                    Spacer()
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.paper)
    }

    private func header(_ ref: ChapterRef) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ref.book.title)
                    .font(.title2)
                    .foregroundStyle(Palette.ink)
                Text(ref.chapter.title.isEmpty ? "未命名章节" : ref.chapter.title)
                    .font(.title3)
                    .foregroundStyle(Palette.ink)
                if let label = ref.book.source?.label, !label.isEmpty {
                    Text(label)
                        .font(.caption)
                        .foregroundStyle(Palette.inkSoft)
                }
            }
            Spacer()
            Button("生成本书") { model.generate() }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    private func segmentRow(_ segment: Segment, chapter: Chapter, book: Book) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(segment.text.isEmpty ? "（空片段）" : segment.text)
                    .font(.system(.body, design: .serif))
                    .foregroundStyle(Palette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                statusPill(segment.audio.status)
                if segment.audio.status == .ready {
                    Button("播放") {
                        model.playSegment(segment, chapter: chapter, book: book)
                    }
                }
            }
            if segment.audio.status == .failed, let error = segment.audio.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Palette.brick)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(model.playingSegmentID == segment.id ? Palette.clay.opacity(0.10) : Palette.card)
        )
    }

    private func statusPill(_ status: AudioStatus) -> some View {
        Text(label(status))
            .font(.caption)
            .foregroundStyle(color(status))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color(status).opacity(0.14)))
    }

    private func label(_ status: AudioStatus) -> String {
        switch status {
        case .pending: "待生成"
        case .ready: "已就绪"
        case .failed: "失败"
        case .unknown: "未知"
        }
    }

    private func color(_ status: AudioStatus) -> Color {
        switch status {
        case .pending: Palette.inkSoft
        case .ready: Palette.moss
        case .failed: Palette.brick
        case .unknown: Palette.inkSoft
        }
    }
}

private struct PrepareForm: View {
    @ObservedObject var model: AppModel
    @Binding var showPDF: Bool
    @Binding var showHTML: Bool
    @Binding var showWAV: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("准备")
                    .font(.title3)
                    .foregroundStyle(Palette.ink)

                labeled("本机服务") {
                    TextField("http://127.0.0.1:4173", text: $model.serverBase)
                        .textFieldStyle(.roundedBorder)
                }
                labeled("Index-TTS") {
                    TextField("http://主机:7860", text: $model.ttsBaseURL)
                        .textFieldStyle(.roundedBorder)
                }
                labeled("语言") {
                    Picker("语言", selection: $model.ttsLang) {
                        Text("ZH 中文").tag("ZH")
                        Text("EN").tag("EN")
                        Text("JA").tag("JA")
                        Text("AR").tag("AR")
                        Text("ES").tag("ES")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                labeled("时长系数") {
                    HStack {
                        TextField(
                            "1",
                            value: $model.durationFactor,
                            format: .number.precision(.fractionLength(0 ... 2))
                        )
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 80)
                        Stepper("时长系数", value: $model.durationFactor, in: 0.5 ... 2, step: 0.05)
                            .labelsHidden()
                    }
                }
                Text(model.voiceLine)
                    .font(.callout)
                    .foregroundStyle(Palette.inkSoft)

                HStack {
                    Button("保存配置") { model.saveConfiguration() }
                    Button("测试连接") { model.testConnection() }
                    Button("试听一句") { model.previewSentence() }
                    Button("上传音色 wav") { showWAV = true }
                }
                .disabled(model.isBusy)

                Divider()

                labeled("网页 URL") {
                    TextField("https://example.com/article", text: $model.pageURL)
                        .textFieldStyle(.roundedBorder)
                }
                HStack {
                    Button("导入 PDF") { showPDF = true }
                    Button("导入 HTML") { showHTML = true }
                    Button("导入 URL") { model.importPage() }
                }
                .disabled(model.isBusy)
            }
            .padding(16)
        }
        .background(Palette.paper)
    }

    private func labeled<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .frame(width: 92, alignment: .leading)
                .foregroundStyle(Palette.inkSoft)
            content()
        }
    }
}

private struct TransportBar: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.nowPlayingText)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Spacer()
                TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                    Text(model.clockText)
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(Palette.inkSoft)
                }
            }
            HStack(spacing: 8) {
                Button("上一段") { model.previousSegment() }
                Button("上一章") { model.previousChapter() }
                Button(model.isPlaying ? "暂停" : "播放") { model.togglePlay() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                Button("下一章") { model.nextChapter() }
                Button("下一段") { model.nextSegment() }
                Picker("倍速", selection: $model.speed) {
                    ForEach(PlaybackRate.allCases) { rate in
                        Text(rate.label).tag(rate)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 110)
                Menu {
                    ForEach(SleepChoice.allCases) { choice in
                        Button(choice.title) { model.chooseSleep(choice) }
                    }
                } label: {
                    Text("睡眠 · \(model.sleepChoice.title)")
                }
                Spacer(minLength: 0)
            }
            Text(model.statusLine.isEmpty ? " " : model.statusLine)
                .font(.callout)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Palette.paperDeep)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Palette.ink.opacity(0.12))
                .frame(height: 1)
        }
    }
}
