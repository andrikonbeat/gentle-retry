<div align="center">

# gentle-retry

**Keep working through transient provider failures.**

Reliable retries for **Pi Coding Agent**, **Gentle Shell**, and **OpenCode 2** —
with automatic session continuation, reconnect after outages, and a clean chat.

[![CI](https://github.com/andrikonbeat/gentle-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/andrikonbeat/gentle-retry/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/andrikonbeat/gentle-retry?display_name=tag)](https://github.com/andrikonbeat/gentle-retry/releases/latest)
[![Node](https://img.shields.io/badge/node-22%20%7C%2024-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Install](#install) · [Features](#features) · [OpenCode](#opencode-2) · [Configuration](#configuration) · [Documentation](#documentation)

</div>

## Why gentle-retry?

Pi already retries transient failures a few times. When that budget runs out,
the run stops — and your work stops with it. gentle-retry waits and tries again
with the same conversation, while keeping permanent failures and retry noise
under control.

## Features

| Capability | What you get |
| --- | --- |
| **Transient retries** | Backoff with jitter and `Retry-After` support for rate limits, timeouts, connection failures, and other temporary errors. |
| **Automatic resume** | Reopen the previous Pi session and continue an interrupted turn without typing `--continue`. |
| **Reconnect mode** | Resume live sessions when internet connectivity returns. |
| **Quiet progress** | Retry state lives in the footer, not in a stream of chat notifications. |
| **Shared policy** | One strict, project-over-global configuration for Pi and OpenCode 2. |
| **Safe by default** | Retry, auto-resume, and reconnect are opt-in. Quota, billing, authentication, and permanent errors are never retried. |

## Install

### Complete setup — recommended

Requirements: Node 22.19+, npm, Pi 1.4+, and Bash, Zsh, or Fish.

```bash
npx --yes https://github.com/andrikonbeat/gentle-retry/releases/latest/download/gentle-retry.tgz
```

Then open a new terminal and enable the features you want:

```text
/gentle:retry enable
/gentle:retry auto-resume on
```

The installer registers the global command and Pi extension, then adds a small
shell function for automatic continuation. It does **not** modify Gentle Shell.
The setup is idempotent, writes atomically, and keeps a backup before the first
change.

- `command gentle-shell` or `command pi` bypasses the launcher.
- `gentle-retry uninstall` removes only the shell integration.
- Recovery and full cleanup are covered in [Troubleshooting](docs/troubleshooting.md).

<details>
<summary><strong>Extension-only and local installation</strong></summary>

<br>

Install the published Pi extension without the launcher:

```bash
pi install npm:gentle-retry
```

Try it once without installing:

```bash
pi -e npm:gentle-retry
```

Use a local checkout:

```bash
pi install /path/to/gentle-retry
```

Without the launcher, reopen the original session with `pi --continue` or
`/resume`.

</details>

## What gets retried?

| Failure | Retried |
| --- | --- |
| HTTP 429, rate limits, throttling | **Yes** |
| Timeouts, dropped connections, DNS failures | **Yes** |
| HTTP 502 and temporary HTTP 503 failures | **Yes** |
| Content-safety screening temporarily unavailable | **Yes** |
| Incomplete streams and named degraded-function errors | **Yes** |
| Quota, billing, payment, or spending limits | **No** |
| Authentication and authorization failures | **No** |
| Generic HTTP 400 or unknown permanent failures | **No** |
| Context-usage warnings requiring compaction | **No** |

Backoff uses factor **1.8**, up to **10% jitter**, and a configurable ceiling.
Valid `Retry-After` guidance takes precedence. Press **Escape** to stop a wait.

## Everyday controls

Run `/gentle:retry` with no arguments to open the interactive menu, or use:

| Command | Action |
| --- | --- |
| `/gentle:retry enable [--global]` | Enable retries for the project or globally. |
| `/gentle:retry disable [--global]` | Disable retries without deleting your settings. |
| `/gentle:retry status` | Show effective policy, limits, and feature state. |
| `/gentle:retry pause` / `resume` | Pause or restore retries for the current session. |
| `/gentle:retry auto-resume on\|off [--global]` | Control continuation after reopening a session. |
| `/gentle:retry reconnect ...` | Configure connectivity recovery. |
| `/gentle:retry doctor` | Inspect configuration and installation diagnostics. |

## Automatic resume and reconnect

With **auto-resume** enabled, an ordinary interactive launch selects the latest
Pi session automatically. gentle-retry then sends one idempotent continuation
prompt only if the turn was interrupted or failed transiently. Completed turns
and permanent failures are left alone.

With **reconnect** enabled, live sessions wait for connectivity instead of
ending when the network goes down. One outage resumes at most three times;
billing and authentication failures never wait.

Both features are opt-in because a recovered turn can repeat a side effect that
already ran. See [Automatic resume and reconnect](docs/auto-resume.md).

## OpenCode 2

Install the plugin:

```bash
opencode plugin add gentle-retry
```

Configure it through OpenCode V2's `plugins` array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "gentle-retry",
      "options": {
        "policy": "on",
        "baseDelayMs": 2000,
        "maxDelayMs": 60000
      }
    }
  ]
}
```

The plugin uses the public `session.retry` hook and shares the project policy
with Pi. OpenCode remains responsible for restart continuation and its own hard
retry ceiling; gentle-retry never starts a competing session or prompt.

## Configuration

The safe default is **off**. Project settings override global settings:

- Project: `<project>/.pi/gentle-ai/retry-policy.json`
- Global: `~/.pi/gentle-ai/retry-policy.json`
- Override: `$GENTLE_PI_CONFIG_HOME/retry-policy.json`

```json
{
  "schema": "gentle-pi.retry/v1",
  "policy": "on",
  "baseDelayMs": 2000,
  "maxDelayMs": 60000,
  "autoResume": false
}
```

Optional `maxAttempts` and `maxElapsedMs` limits are available when you want a
bounded retry sequence. Missing or malformed policy fails closed to `off`.
See [Configuration reference](docs/configuration.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [Configuration](docs/configuration.md) | Policy fields, backoff, limits, and OpenCode options. |
| [Auto-resume and reconnect](docs/auto-resume.md) | Recovery behavior, safety boundaries, and lifecycle details. |
| [Troubleshooting](docs/troubleshooting.md) | Common failures, recovery, and complete uninstall steps. |
| [Changelog](CHANGELOG.md) | User-facing changes by release. |
| [Contributing](CONTRIBUTING.md) | Development workflow and pull-request contract. |
| [Security](SECURITY.md) | How to report vulnerabilities privately. |

## Development

```bash
pnpm install
pnpm run check     # TypeScript check
pnpm test          # Build and run the complete suite
pnpm run build     # Compile to dist/
pnpm run verify:package
```

The suite covers Pi's real extension loader, the OpenCode adapter, retry
boundaries, shell integration, and the packed release artifact.

Maintainer release steps are in [docs/release.md](docs/release.md).

## License

[MIT](LICENSE)
