# tethro-cli

CLI for sandboxing AI coding agents. Run Claude Code, Codex CLI, and Aider in isolated workspaces with credential proxying, optional container isolation, and audit logging.

```bash
npm i -g tethro-cli
# or
brew install tethro/tap/tethro

tethro doctor
tethro run claude-code "fix the bug"
```

## Open source vs commercial

This CLI is **Apache 2.0**. Pair it with the open-source credential proxy, MCP gateway, and audit WebSocket for a full local stack.

The **hosted console**, SSO/SAML/SCIM, SIEM, compliance packs, and cloud sandboxes are **commercial** — they are not in this repository. See [tethro.dev](https://tethro.dev).

## License

Apache 2.0
