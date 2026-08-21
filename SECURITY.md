# Security Policy

## Supported versions

Security fixes are applied on the latest published npm version of `dsh-codex-sync` (`latest` on [npm](https://www.npmjs.com/package/dsh-codex-sync)).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

1. Use [GitHub Security Advisories](https://github.com/Walvez/dsh-codex-sync/security/advisories/new) if you have a GitHub account, **or**
2. Email the maintainer via the address on the [GitHub profile](https://github.com/Walvez).

Include:
- affected version / commit
- a short description of the issue
- steps to reproduce (PoC welcome; no exploit against third-party systems)

You should get an acknowledgement within a few days. Please give us time to ship a fix before any public disclosure.

## Scope

In scope: this repository (`lib/`, `bin/`, the published npm package, and the Codex reverse-MCP installer it wires).

Out of scope: DeepSeek Harness itself, OpenAI Codex, third-party MCP servers, and scanning repositories you do not own.
