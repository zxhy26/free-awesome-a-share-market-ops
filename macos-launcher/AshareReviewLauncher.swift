import AppKit
import Darwin
import Foundation
import WebKit

struct LauncherConfig: Codable {
    let displayName: String
    let edition: String
    let releaseEdition: String
    let version: String
    let payloadRevision: String
    let appSupportDirectory: String
    let minimumWidth: Double
    let minimumHeight: Double
}

struct LauncherTestResult: Codable {
    let ok: Bool
    let displayName: String
    let edition: String
    let releaseEdition: String
    let version: String
    let nodeVersion: String
    let serviceExists: Bool
    let payloadExists: Bool
}

enum LauncherError: LocalizedError {
    case missingResource(String)
    case invalidConfig(String)
    case serviceStopped(String)

    var errorDescription: String? {
        switch self {
        case .missingResource(let value): return "软件包缺少运行文件：\(value)"
        case .invalidConfig(let value): return "启动配置无效：\(value)"
        case .serviceStopped(let value): return "本地数据服务启动失败：\(value)"
        }
    }
}

func resourceURL(_ relativePath: String) throws -> URL {
    guard let resources = Bundle.main.resourceURL else {
        throw LauncherError.missingResource("Contents/Resources")
    }
    let value = resources.appendingPathComponent(relativePath)
    guard FileManager.default.fileExists(atPath: value.path) else {
        throw LauncherError.missingResource(relativePath)
    }
    return value
}

func loadLauncherConfig() throws -> LauncherConfig {
    let url = try resourceURL("launcher-config.json")
    do {
        return try JSONDecoder().decode(LauncherConfig.self, from: Data(contentsOf: url))
    } catch {
        throw LauncherError.invalidConfig(error.localizedDescription)
    }
}

func safeDirectoryName(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_"))
    return value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
}

func applicationSupportRoot(config: LauncherConfig) throws -> URL {
    guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
        throw LauncherError.invalidConfig("无法读取用户应用数据目录")
    }
    return root.appendingPathComponent(config.appSupportDirectory, isDirectory: true)
        .appendingPathComponent(config.releaseEdition, isDirectory: true)
}

func preparePortableRuntime(config: LauncherConfig) throws -> (runtime: URL, state: URL) {
    let fileManager = FileManager.default
    let sourcePayload = try resourceURL("payload")
    let base = try applicationSupportRoot(config: config)
    let runtimes = base.appendingPathComponent("runtimes", isDirectory: true)
    let state = base.appendingPathComponent("state", isDirectory: true)
    try fileManager.createDirectory(at: runtimes, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: state, withIntermediateDirectories: true)

    let directoryName = safeDirectoryName("\(config.version)-\(config.payloadRevision)")
    let target = runtimes.appendingPathComponent(directoryName, isDirectory: true)
    let marker = target.appendingPathComponent(".macos-payload-ready")
    if !fileManager.fileExists(atPath: marker.path) {
        let temporary = runtimes.appendingPathComponent(".incoming-\(UUID().uuidString)", isDirectory: true)
        try? fileManager.removeItem(at: temporary)
        do {
            try fileManager.copyItem(at: sourcePayload, to: temporary)
            try Data(config.payloadRevision.utf8).write(to: temporary.appendingPathComponent(".macos-payload-ready"), options: .atomic)
            if fileManager.fileExists(atPath: target.path) {
                try fileManager.removeItem(at: target)
            }
            try fileManager.moveItem(at: temporary, to: target)
        } catch {
            try? fileManager.removeItem(at: temporary)
            throw error
        }
    }
    return (target, state)
}

func runProcess(_ executable: URL, arguments: [String]) throws -> String {
    let process = Process()
    let output = Pipe()
    process.executableURL = executable
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = output
    try process.run()
    process.waitUntilExit()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func writeLauncherMetadata(runtime: URL, config: LauncherConfig) throws {
    let metadata: [String: Any] = [
        "version": config.version,
        "edition": config.edition,
        "releaseEdition": config.releaseEdition,
        "launcherPath": Bundle.main.bundlePath,
        "platform": "darwin",
    ]
    let data = try JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: runtime.appendingPathComponent(".launcher.json"), options: .atomic)
}

func runLauncherSelfTest() -> Never {
    do {
        let config = try loadLauncherConfig()
        let node = try resourceURL("runtime/node")
        let payload = try resourceURL("payload")
        let service = payload.appendingPathComponent("程序/应用/backend/复盘同步服务.js")
        let nodeVersion = try runProcess(node, arguments: ["--version"])
        let result = LauncherTestResult(
            ok: nodeVersion.hasPrefix("v"),
            displayName: config.displayName,
            edition: config.edition,
            releaseEdition: config.releaseEdition,
            version: config.version,
            nodeVersion: nodeVersion,
            serviceExists: FileManager.default.fileExists(atPath: service.path),
            payloadExists: FileManager.default.fileExists(atPath: payload.path)
        )
        let data = try JSONEncoder().encode(result)
        if let outputPath = ProcessInfo.processInfo.environment["A_SHARE_REVIEW_MAC_LAUNCHER_TEST_RESULT"], !outputPath.isEmpty {
            try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(result.ok && result.serviceExists && result.payloadExists ? 0 : 1)
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private var logHandle: FileHandle?
    private var runtimeURL: URL?
    private var currentRuntimeName = ""
    private var baseURL: URL?
    private var config: LauncherConfig?
    private var pollAttempts = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let config = try loadLauncherConfig()
            self.config = config
            let prepared = try preparePortableRuntime(config: config)
            runtimeURL = prepared.runtime
            currentRuntimeName = prepared.runtime.lastPathComponent
            try writeLauncherMetadata(runtime: prepared.runtime, config: config)
            createWindow(config: config)
            try startServer(config: config, runtime: prepared.runtime, state: prepared.state)
            pollService()
        } catch {
            presentFatalError(error.localizedDescription)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let process = serverProcess, process.isRunning {
            process.terminate()
            usleep(250_000)
            if process.isRunning { process.interrupt() }
        }
        try? logHandle?.close()
    }

    private func createWindow(config: LauncherConfig) {
        let width = max(1180, config.minimumWidth)
        let height = max(760, config.minimumHeight)
        let frame = NSRect(x: 0, y: 0, width: width, height: height)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = config.displayName
        window.minSize = NSSize(width: 980, height: 680)
        window.center()
        window.setFrameAutosaveName("\(config.releaseEdition)-main-window")

        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.websiteDataStore = .default()
        let webView = WKWebView(frame: frame, configuration: webConfiguration)
        webView.navigationDelegate = self
        webView.allowsMagnification = true
        window.contentView = webView

        let loading = """
        <!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;background:#eef0f2;color:#30343b;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
        body{display:grid;place-items:center}.box{text-align:center}.spinner{width:28px;height:28px;margin:0 auto 16px;border:3px solid #c7cbd1;border-top-color:#d94a4a;border-radius:50%;animation:r .8s linear infinite}@keyframes r{to{transform:rotate(360deg)}}
        </style><body><div class="box"><div class="spinner"></div><strong>正在启动实时数据服务</strong></div></body></html>
        """
        webView.loadHTMLString(loading, baseURL: nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        self.webView = webView
    }

    private func startServer(config: LauncherConfig, runtime: URL, state: URL) throws {
        let node = try resourceURL("runtime/node")
        let service = runtime.appendingPathComponent("程序/应用/backend/复盘同步服务.js")
        guard FileManager.default.fileExists(atPath: service.path) else {
            throw LauncherError.missingResource("程序/应用/backend/复盘同步服务.js")
        }
        let port = Int.random(in: 21000...49000)
        let url = URL(string: "http://127.0.0.1:\(port)/app/")!
        baseURL = url

        let logs = state.appendingPathComponent("logs", isDirectory: true)
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let logURL = logs.appendingPathComponent("服务日志.txt")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let logHandle = try FileHandle(forWritingTo: logURL)
        try logHandle.seekToEnd()
        self.logHandle = logHandle

        var environment = ProcessInfo.processInfo.environment
        environment["A_SHARE_REVIEW_PORT"] = String(port)
        environment["A_SHARE_REVIEW_HOST"] = "127.0.0.1"
        environment["A_SHARE_REVIEW_PORTABLE_ROOT"] = runtime.path
        environment["A_SHARE_REVIEW_APP_DIR"] = runtime.appendingPathComponent("程序/应用").path
        environment["A_SHARE_REVIEW_EDITION"] = config.edition
        environment["A_SHARE_REVIEW_RELEASE_EDITION"] = config.releaseEdition
        environment["A_SHARE_REVIEW_LAUNCHER_VERSION"] = config.version
        environment["A_SHARE_REVIEW_MEMBER_DATA_DIR"] = state.appendingPathComponent("membership", isDirectory: true).path
        environment["A_SHARE_REVIEW_PREFERENCES_PATH"] = state.appendingPathComponent("用户设置.json").path
        environment["A_SHARE_REVIEW_LOG_PATH"] = logURL.path
        environment["A_SHARE_REVIEW_SHARED_FLOW_PATH"] = state.appendingPathComponent("板块资金分时缓存.json").path
        environment["A_SHARE_REVIEW_MAC_TRADING_STATE"] = state.appendingPathComponent("macOS交易软件.json").path
        environment["LOCALAPPDATA"] = state.path

        let process = Process()
        process.executableURL = node
        process.arguments = [service.path]
        process.currentDirectoryURL = service.deletingLastPathComponent()
        process.environment = environment
        process.standardOutput = logHandle
        process.standardError = logHandle
        try process.run()
        serverProcess = process
    }

    private func pollService() {
        guard let baseURL else { return }
        var healthComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        healthComponents?.path = "/api/v1/health"
        guard let healthURL = healthComponents?.url else {
            presentFatalError("本地服务地址无效。")
            return
        }
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                if status == 200 {
                    self.webView?.load(URLRequest(url: baseURL))
                    self.cleanupOldRuntimes()
                    return
                }
                self.pollAttempts += 1
                if self.pollAttempts >= 80 || self.serverProcess?.isRunning == false {
                    let message = self.serverProcess?.isRunning == false ? "服务进程已退出，请查看服务日志。" : "等待本地服务超时。"
                    self.presentFatalError(message)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.pollService() }
            }
        }.resume()
    }

    private func cleanupOldRuntimes() {
        guard let runtimeURL else { return }
        let parent = runtimeURL.deletingLastPathComponent()
        guard let entries = try? FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
        for entry in entries where entry.lastPathComponent != currentRuntimeName && !entry.lastPathComponent.hasPrefix(".incoming-") {
            try? FileManager.default.removeItem(at: entry)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if let baseURL, url.host == baseURL.host && url.port == baseURL.port {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    private func presentFatalError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "复盘软件无法启动"
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

if ProcessInfo.processInfo.environment["A_SHARE_REVIEW_MAC_LAUNCHER_TEST_ONLY"] == "1" {
    runLauncherSelfTest()
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
