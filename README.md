# @agentrq/codex-gateway

MCP bridge CLI that connects [OpenAI Codex](https://github.com/openai/codex) to [agentrq](https://agentrq.com) workspaces.

> [!WARNING]
> **Pre-Alpha**: This project is in early development. APIs, configurations, and behaviors are subject to change without notice.

## Overview

`@agentrq/codex-gateway` bridges the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) with the [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) (JSON-RPC 2.0 over stdio).

It automates task execution by:

1. Loading your workspace's `.mcp.json` configuration.
2. Connecting to the agentrq MCP server.
3. Spawning `codex app-server` as a subprocess.
4. Routing tasks from agentrq to Codex threads/turns.
5. Collecting agent replies and sending them back to agentrq.
6. Auto-reconnecting the MCP transport on disconnection.

## Prerequisites

- **Node.js** >= 20
- **OpenAI Codex CLI** (`npm install -g @openai/codex`)
- An [agentrq](https://agentrq.com) workspace with an HTTP MCP server

## Installation

```bash
npm install -g @agentrq/codex-gateway@latest
```

## Setup

### 1. Configure agentrq MCP server for Codex (project-level)

Codex reads project-level MCP server config from `.codex/config.toml`. Create this file so the Codex agent can use agentrq tools directly during task execution (replace `<WORKSPACEID>` and `<TOKEN>` with your values from the agentrq dashboard):

```bash
mkdir -p .codex
cat >> .codex/config.toml << 'EOF'

[mcp_servers.agentrq-workspace]
url = "https://<WORKSPACEID>.mcp.agentrq.com/mcp?token=<TOKEN>"
EOF
```

### 2. Configure the gateway's agentrq connection

Create a `.mcp.json` in your project root so `codex-gateway` can connect to the same agentrq workspace:

```json
{
  "mcpServers": {
    "agentrq": {
      "type": "http",
      "url": "https://<WORKSPACEID>.mcp.agentrq.com/mcp?token=<TOKEN>"
    }
  }
}
```

> **Note:** `.mcp.json` is used by `codex-gateway` to receive tasks. `.codex/config.toml` is used by the Codex agent itself to call agentrq tools (e.g. `reply`, `updateTaskStatus`) during execution.

## Usage

Run `codex-gateway` from your agentrq workspace root (the directory containing `.mcp.json`):

```bash
# Default: runs `codex app-server`
codex-gateway

# Custom codex command
codex-gateway -- codex app-server
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CODEX_MODEL` | Override the model used for all threads/turns | _(codex default)_ |

### Configuration

`codex-gateway` searches for `.mcp.json` starting in the current working directory and up to 3 parent directories.

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "agentrq": {
      "type": "http",
      "url": "https://your-workspace.mcp.agentrq.com?token=..."
    }
  }
}
```

`codex-gateway` prefers servers with `agentrq` in the name; falls back to the first HTTP server with a `url`.

## How It Works

```
┌──────────────────────────┐    JSON-RPC 2.0 / JSONL     ┌─────────────────┐
│  codex app-server        │ ◄─────────────────────────► │                 │
│  (OpenAI Codex agent)    │                             │  codex-gateway  │
└──────────────────────────┘                             │                 │
                                                         │  MCP Bridge     │
                                                         │                 │
                                     ┌───────────────────┤                 │
                                     │                   │                 │
                                     ▼                   └─────────────────┘
                        ┌───────────────────────────┐
                        │  agentrq MCP Server       │
                        │  (HTTP / StreamableHTTP)  │
                        └───────────────────────────┘
```

### Flow

1. **Config Loading** — Reads `.mcp.json` to find the agentrq MCP server.
2. **MCP Connection** — Establishes a `StreamableHTTPClientTransport` with automatic retry and reconnection.
3. **Codex Spawning** — Launches `codex app-server` via stdio.
4. **Handshake** — Sends `initialize` + `initialized` to the Codex app-server.
5. **Task Routing** — When a task arrives from agentrq:
   - Extracts `chat_id` as the task identifier.
   - Creates a new Codex thread for the chat (or reuses one if the same `chat_id` arrives again).
   - Starts a turn with the task content.
   - Streams `item/agentMessage/delta` notifications into a reply buffer.
6. **Reply** — When `turn/completed` fires, sends the buffered text back via agentrq's `reply` tool.
7. **Recursive Execution** — After each task, checks for the next pending task automatically.

### Key Components

| File | Description |
|---|---|
| `src/index.ts` | Entry point; orchestrates config loading, MCP connection, Codex spawning, and task lifecycle. |
| `src/codexClient.ts` | JSON-RPC 2.0 client for the Codex app-server — handles JSONL I/O, request correlation, and turn completion. |
| `src/mcpClient.ts` | `EventEmitter`-based MCP client with auto-reconnection, notification handling, and tool call dispatch. |
| `src/config.ts` | Parses `.mcp.json` from the current directory tree up to 3 levels deep. |
| `src/taskIdentity.ts` | Extracts `chat_id` from MCP notification metadata or task text. |

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Type-check
npm run typecheck

# Run tests
npm test
```

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add: amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Contributing License

By contributing to this project, you agree that your contributions will be licensed under the project's Apache License 2.0.

---

## License

Apache License 2.0

Copyright (c) 2026 Contextual, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
