import Darwin
import Foundation
import StarlingsContracts

@main
struct StarlingsCLI {
    static func main() async {
        do {
            let invocation = try CLIInvocation(arguments: Array(CommandLine.arguments.dropFirst()))
            if invocation.command == "help" {
                print(helpText)
                return
            }
            if invocation.command == "version" {
                let value = "{\"cli_version\":\"0.1.0\",\"protocol_version\":\(meetCLIProtocolVersion)}\n"
                FileHandle.standardOutput.write(Data(value.utf8))
                return
            }

            let responseTimeout: Int = switch invocation.command {
            case "auth": 300
            case "host", "join", "leave": 30
            default: 10
            }
            let client = StarlingsCommandClient(responseTimeoutSeconds: responseTimeout)
            let request = StarlingsCLIRequest(command: invocation.command, arguments: invocation.requestArguments)
            let response = try await send(
                request,
                with: client,
                launchIfNeeded: invocation.launchIfNeeded
            )
            try write(response, pretty: invocation.pretty, to: .standardOutput)
            if !response.ok { Darwin.exit(4) }

            if invocation.followTranscript {
                var previous = response.output?.transcript
                while true {
                    try await Task.sleep(for: .seconds(1))
                    let next = try await send(
                        StarlingsCLIRequest(command: "transcript"),
                        with: client,
                        launchIfNeeded: false
                    )
                    if next.output?.transcript != previous {
                        try write(next, pretty: false, to: .standardOutput)
                        previous = next.output?.transcript
                    }
                }
            }
        } catch let error as CLIUsageError {
            writeLocalError(code: "usage", message: error.localizedDescription, exitCode: 2)
        } catch StarlingsCLITransportError.appUnavailable {
            writeLocalError(
                code: "app_unavailable",
                message: "\(ContractConstants.nativeAppName).app is not running or couldn’t be launched.",
                exitCode: 3
            )
        } catch {
            writeLocalError(code: "cli_failed", message: error.localizedDescription, exitCode: 3)
        }
    }

    private static func send(
        _ request: StarlingsCLIRequest,
        with client: StarlingsCommandClient,
        launchIfNeeded: Bool
    ) async throws -> StarlingsCLIResponse {
        do {
            return try client.send(request)
        } catch StarlingsCLITransportError.appUnavailable {
            guard launchIfNeeded else { throw StarlingsCLITransportError.appUnavailable }
        }

        try launchMeetApp()
        for _ in 0..<60 {
            try await Task.sleep(for: .milliseconds(100))
            do {
                return try client.send(request)
            } catch StarlingsCLITransportError.appUnavailable {
                continue
            }
        }
        throw StarlingsCLITransportError.appUnavailable
    }

    private static func launchMeetApp() throws {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let siblingApp = executable.deletingLastPathComponent().appending(path: "\(ContractConstants.nativeAppName).app")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        if FileManager.default.fileExists(atPath: siblingApp.path) {
            process.arguments = [siblingApp.path]
        } else {
            process.arguments = ["-b", ContractConstants.nativeAppBundleID]
        }
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw StarlingsCLITransportError.appUnavailable }
    }

    private static func write(_ response: StarlingsCLIResponse, pretty: Bool, to handle: FileHandle) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys] : [.sortedKeys]
        var data = try encoder.encode(response)
        data.append(0x0A)
        handle.write(data)
    }

    private static func writeLocalError(code: String, message: String, exitCode: Int32) -> Never {
        let request = StarlingsCLIRequest(command: "cli", id: "local")
        let response = StarlingsCLIResponse.failure(for: request, code: code, message: message)
        try? write(response, pretty: false, to: .standardError)
        Darwin.exit(exitCode)
    }
}

private struct CLIInvocation {
    let command: String
    let requestArguments: [String: String]
    let launchIfNeeded: Bool
    let pretty: Bool
    let followTranscript: Bool

    init(arguments originalArguments: [String]) throws {
        var arguments = originalArguments
        pretty = removeFlag("--pretty", from: &arguments)
        _ = removeFlag("--json", from: &arguments)
        launchIfNeeded = !removeFlag("--no-launch", from: &arguments)
        let follow = removeFlag("--follow", from: &arguments)

        guard let rawCommand = arguments.first else {
            command = "status"
            requestArguments = [:]
            followTranscript = false
            return
        }
        arguments.removeFirst()
        let parsed = try Self.parse(arguments)
        var values = parsed.options
        followTranscript = follow

        switch rawCommand {
        case "help", "--help", "-h":
            command = "help"
        case "version", "--version":
            command = "version"
        case "status", "devices", "show", "auth", "leave", "lobby":
            command = rawCommand
            try Self.requireNoPositionals(parsed.positionals, command: rawCommand)
        case "host":
            command = "host"
            if let room = parsed.positionals.first { values["room"] = room }
            try Self.requireMaximumPositionals(parsed.positionals, count: 1, command: rawCommand)
        case "join":
            command = "join"
            if let room = parsed.positionals.first { values["room"] = room }
            try Self.requireMaximumPositionals(parsed.positionals, count: 1, command: rawCommand)
            guard values["room"]?.isEmpty == false else {
                throw CLIUsageError.message("join requires a room slug.")
            }
        case "admit", "reject":
            command = rawCommand
            if let requestID = parsed.positionals.first { values["request_id"] = requestID }
            try Self.requireMaximumPositionals(parsed.positionals, count: 1, command: rawCommand)
        case "microphone", "camera", "blur", "screen-share":
            command = rawCommand
            values["state"] = parsed.positionals.first ?? values["state"] ?? "toggle"
            try Self.requireMaximumPositionals(parsed.positionals, count: 1, command: rawCommand)
        case "select-camera", "select-microphone", "select-speaker":
            command = rawCommand
            if let id = parsed.positionals.first { values["id"] = id }
            try Self.requireMaximumPositionals(parsed.positionals, count: 1, command: rawCommand)
        case "transcript":
            command = rawCommand
            try Self.requireNoPositionals(parsed.positionals, command: rawCommand)
        case "plan":
            // `plan`, `plan set <plan>`, `plan keep <project-id>`. The app
            // reads them as three commands; the Worker checks who may write.
            let rest = Array(parsed.positionals.dropFirst())
            switch parsed.positionals.first {
            case nil:
                command = "plan"
            case "set"?:
                command = "plan-set"
                try Self.requireMaximumPositionals(rest, count: 1, command: "plan set")
                let known = WorkspacePlanUpdateRequestPlan.known.map(\.rawValue)
                guard let plan = rest.first, known.contains(plan) else {
                    throw CLIUsageError.message("plan set takes one of: \(known.joined(separator: ", ")).")
                }
                values["plan"] = plan
            case "keep"?:
                command = "plan-keep"
                try Self.requireMaximumPositionals(rest, count: 1, command: "plan keep")
                guard let projectID = rest.first, !projectID.isEmpty else {
                    throw CLIUsageError.message("plan keep requires a project id.")
                }
                values["project_id"] = projectID
            case let other?:
                throw CLIUsageError.message("Unknown plan action '\(other)'. Run starlings help.")
            }
        default:
            throw CLIUsageError.message("Unknown command '\(rawCommand)'. Run starlings help.")
        }
        requestArguments = values
    }

    private struct ParsedArguments {
        var options: [String: String]
        var positionals: [String]
    }

    private static func parse(_ arguments: [String]) throws -> ParsedArguments {
        var options: [String: String] = [:]
        var positionals: [String] = []
        var index = 0
        while index < arguments.count {
            let value = arguments[index]
            if value.hasPrefix("--") {
                let key = String(value.dropFirst(2)).replacingOccurrences(of: "-", with: "_")
                guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
                    throw CLIUsageError.message("Option \(value) needs a value.")
                }
                options[key] = arguments[index + 1]
                index += 2
                continue
            }
            positionals.append(value)
            index += 1
        }
        return ParsedArguments(options: options, positionals: positionals)
    }

    private static func requireNoPositionals(_ values: [String], command: String) throws {
        try requireMaximumPositionals(values, count: 0, command: command)
    }

    private static func requireMaximumPositionals(_ values: [String], count: Int, command: String) throws {
        if values.count > count {
            throw CLIUsageError.message("Too many arguments for \(command). Run starlings help.")
        }
    }
}

private enum CLIUsageError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message): message
        }
    }
}

private func removeFlag(_ flag: String, from arguments: inout [String]) -> Bool {
    let present = arguments.contains(flag)
    arguments.removeAll(where: { $0 == flag })
    return present
}

private let helpText = """
starlings controls the native Starlings app. Operational commands emit JSON.

Usage:
  starlings [status] [--pretty] [--no-launch]
  starlings show
  starlings auth
  starlings host [room] [--name NAME --email EMAIL] [--camera-id ID] [--microphone-id ID]
                [--speaker-id ID]
  starlings join <room> --name NAME [--email EMAIL] [--notes]
  starlings leave
  starlings lobby
  starlings admit [request-id]
  starlings reject [request-id]
  starlings devices
  starlings select-camera <device-id>
  starlings select-microphone <device-id>
  starlings select-speaker <device-id>   # where the room plays; works mid-meeting
  starlings microphone|camera|screen-share on|off|toggle
  starlings blur   # opens macOS Video Effects; status reports Portrait on/off
  starlings transcript [--follow]
  starlings plan                    # the workspace plan, its project limit and kept project
  starlings plan set <free|starter|pro>   # root admin only
  starlings plan keep <project-id>  # admin; on Free, the one writable project, once
  starlings version

Exit codes:
  0 success
  2 invalid CLI usage
  3 app or transport unavailable
  4 command rejected by Starlings
"""
