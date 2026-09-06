# @agentrq/codex-gateway

> [!CAUTION]
> **Deprecated.** `@agentrq/codex-gateway` is no longer maintained and has been
> replaced by [`@agentrq/acp-gateway`](https://www.npmjs.com/package/@agentrq/acp-gateway),
> which speaks the [Agent Client Protocol](https://agentclientprotocol.com) and
> supports Codex through the `codex-acp` agent (plus other ACP agents).
> Please migrate — this package will receive no further releases.

## Usage

Authenticate once, then run the gateway from your agentrq workspace root:

```bash
npx @agentrq/acp-gateway@latest --login --agent codex-acp
npx @agentrq/acp-gateway@latest --agent codex-acp
```

If you installed the old CLI globally, uninstall it:

```bash
npm uninstall -g @agentrq/codex-gateway
```

## License

Apache License 2.0

Copyright (c) 2026 Contextual, Inc.
