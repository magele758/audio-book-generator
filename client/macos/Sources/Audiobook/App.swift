import AppKit
import AudiobookCore
import SwiftUI

@main
struct AudiobookApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model: AppModel

    init() {
        if CommandLine.arguments.contains("--self-check") {
            let failures = SelfCheck.run()
            if failures.isEmpty {
                print("self-check ok")
            } else {
                for failure in failures {
                    FileHandle.standardError.write(Data((failure + "\n").utf8))
                }
            }
            exit(failures.isEmpty ? 0 : 1)
        }
        _model = StateObject(wrappedValue: AppModel())
    }

    var body: some Scene {
        WindowGroup("有声书") {
            RootView(model: model)
                .preferredColorScheme(.light)
                .tint(Palette.clay)
                .frame(minWidth: 920, minHeight: 640)
        }
        .defaultSize(width: 1120, height: 760)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
