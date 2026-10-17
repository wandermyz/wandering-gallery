import Foundation

/// The server's live updates (`GET /api/events`, Server-Sent Events): one `ChangeEvent`
/// per `change` event, reconnecting after 5 s whenever the stream drops.
nonisolated struct EventStream: Sendable {
    let client: APIClient

    func changes() -> AsyncStream<ChangeEvent> {
        AsyncStream { continuation in
            let task = Task {
                while !Task.isCancelled {
                    do {
                        var req = URLRequest(url: client.url("/api/events"))
                        req.timeoutInterval = 60 * 60 * 24
                        let (bytes, response) = try await client.session.bytes(for: req)
                        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                        var parser = SSEParser()
                        for try await line in bytes.lines {
                            // `lines` skips empty lines, so an event ends at the next field line.
                            for ev in parser.feed(line) { emit(ev, continuation) }
                        }
                        for ev in parser.finish() { emit(ev, continuation) }
                    } catch {
                        if Task.isCancelled { break }
                    }
                    try? await Task.sleep(for: .seconds(5))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func emit(_ ev: SSEParser.Event, _ c: AsyncStream<ChangeEvent>.Continuation) {
        guard ev.event == "change", let data = ev.data.data(using: .utf8),
              let change = try? JSONDecoder().decode(ChangeEvent.self, from: data) else { return }
        c.yield(change)
    }
}

/// Splits an SSE stream into events. `AsyncLineSequence` drops the blank lines that end
/// events, so a named event (`event:` then `data:`, as the server writes them, with JSON on
/// one line) ends at its `data:` line; otherwise at a blank line or `finish()`.
nonisolated struct SSEParser: Sendable {
    nonisolated struct Event: Equatable, Sendable {
        var event: String
        var data: String
    }

    private var event: String?
    private var data: [String] = []

    mutating func feed(_ line: String) -> [Event] {
        if line.isEmpty { return finish() }
        if line.hasPrefix(":") { return [] }
        let (field, value) = Self.split(line)
        switch field {
        case "event":
            let done = finish()
            event = value
            return done
        case "data":
            data.append(value)
            if event != nil { return finish() }
        default:
            break
        }
        return []
    }

    mutating func finish() -> [Event] {
        defer {
            event = nil
            data = []
        }
        guard !data.isEmpty else { return [] }
        return [Event(event: event ?? "message", data: data.joined(separator: "\n"))]
    }

    private static func split(_ line: String) -> (String, String) {
        guard let i = line.firstIndex(of: ":") else { return (line, "") }
        var v = line[line.index(after: i)...]
        if v.hasPrefix(" ") { v = v.dropFirst() }
        return (String(line[..<i]), String(v))
    }
}
