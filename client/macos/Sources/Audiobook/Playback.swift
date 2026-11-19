import AVFoundation
import AudiobookCore
import Foundation

@MainActor
final class ClipPlayer {
    private let av = AVPlayer()
    private var endObserver: NSObjectProtocol?
    private var statusObserver: NSKeyValueObservation?
    private var wantedRate: Float = 1
    var onEnded: (() -> Void)?
    var onFailed: ((String) -> Void)?

    func play(url: URL, rate: Float) {
        load(url: url, rate: rate, start: true)
    }

    func stage(url: URL, rate: Float) {
        load(url: url, rate: rate, start: false)
    }

    func setRate(_ rate: Float) {
        wantedRate = rate
        if av.timeControlStatus == .playing {
            av.rate = rate
        }
    }

    func pause() {
        av.pause()
    }

    func resume() {
        if let item = av.currentItem {
            let duration = item.duration.seconds
            let current = item.currentTime().seconds
            if duration.isFinite, current.isFinite, duration - current < 0.25 {
                av.seek(to: .zero)
            }
        }
        av.play()
        av.rate = wantedRate
    }

    var clockText: String {
        let item = av.currentItem
        return "\(Self.format(item?.currentTime().seconds)) / \(Self.format(item?.duration.seconds))"
    }

    private func load(url: URL, rate: Float, start: Bool) {
        wantedRate = rate
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .timeDomain
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
        statusObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            let status = item.status
            let message = item.error?.localizedDescription
            Task { @MainActor in
                guard let self, item === self.av.currentItem else { return }
                if status == .readyToPlay, self.av.timeControlStatus != .paused {
                    // AVPlayer resets rate to 1 when the item becomes ready.
                    self.av.rate = self.wantedRate
                } else if status == .failed {
                    self.av.pause()
                    self.onFailed?(message ?? "无法播放这一段")
                }
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.onEnded?()
            }
        }
        av.replaceCurrentItem(with: item)
        if start {
            av.play()
            av.rate = rate
        } else {
            av.pause()
        }
    }

    private static func format(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return "0:00" }
        let whole = Int(seconds.rounded(.down))
        return "\(whole / 60):" + String(format: "%02d", whole % 60)
    }
}

@MainActor
final class PreviewSpeaker {
    private var audio: AVAudioPlayer?

    func play(data: Data) throws {
        if data.isEmpty {
            throw ServerFailure(message: "试听音频是空的")
        }
        let player = try AVAudioPlayer(data: data)
        player.prepareToPlay()
        audio = player
        guard player.play() else {
            throw ServerFailure(message: "无法播放试听音频")
        }
    }

    func stop() {
        audio?.stop()
        audio = nil
    }
}
