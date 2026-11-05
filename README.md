# gentle-retry

Unlimited retry for transient provider failures in [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) and [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell).

Pi already retries transient failures a few times with its own backoff. When that
budget runs out, the run stops and the work in progress stops with it. This
extension keeps the run alive instead: it waits, asks again with the same
conversation, and repeats for as long as the cause stays transient.

It never retries quota, billing, payment, upgrade, authentication, or
authorization failures. Waiting does not fix those, and pretending otherwise
only wastes your time.

## Install

```bash
pi install npm:gentle-retry
```

Try it without installing:

```bash
pi -e npm:gentle-retry
```

From a local checkout:

```bash
pi install /path/to/gentle-retry
```

Requirements: Pi Coding Agent 1.4.0 or newer, Node 22.19 or newer.

> `pnpm add -g gentle-retry` does not register an extension with Pi. Use
> `pi install`, or drop it under `~/.pi/agent/extensions/`.

## First run

The extension installs **off**. That is deliberate: an unlimited retry loop
should never switch itself on without you asking. The first time it loads in a
project it says so, once, and names the command that turns it on:

```
gentle-retry installed — OFF. Tailored for HTTP 429 and timeouts:
/gentle:retry enable keeps a run alive instead of stopping.
```

The notice appears once per machine and never again. Scripted and headless runs
never see it.

## Commands

```
/gentle:retry enable     # keep runs alive through 429 and timeouts
/gentle:retry disable    # back to Pi's own retry budget
/gentle:retry status     # current state, and which config file decided it
```

## What it retries

| Cause | Retried |
| --- | --- |
| HTTP 429, rate limit, throttling | yes |
| Timeout, deadline exceeded, dropped connection | yes |
| Connection error | yes |
| HTTP 502 or Bad Gateway | yes |
| Stream ended without `finish_reason` | yes |
| HTTP 400 with `DEGRADED function cannot be invoked` | yes |
| Any other HTTP 400 | no |
| Quota exhausted, billing, credit, payment, upgrade or spending limit | no |
| Authentication, authorization, any other error | no |

When the provider includes usable `Retry-After` guidance (delta-seconds or an
HTTP date), that value controls the next wait. It is still capped by
`maxDelayMs`; malformed or unknown guidance falls back to normal backoff.

When a retry happens you see which failure it is waiting on, how long, and how
many attempts have already failed:

```
Retry 3 (HTTP 429 / rate limit) — waiting 7s… Press Esc to stop.
```

Press **Escape** at any moment to stop the wait.

## Configuration

The safe default is off. Both files are optional, and the project file wins:

- Project: `<project>/.pi/gentle-ai/retry-policy.json`
- Global: `~/.pi/gentle-ai/retry-policy.json`, or `$GENTLE_PI_CONFIG_HOME/retry-policy.json`

```json
{
  "schema": "gentle-pi.retry/v1",
  "policy": "on",
  "baseDelayMs": 2000,
  "maxDelayMs": 60000
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `policy` | `"off"` | `"on"` or `"off"`. Anything else fails closed. |
| `baseDelayMs` | `2000` | First wait, in milliseconds. |
| `maxDelayMs` | `60000` | Ceiling for the growing wait. |

Each attempt multiplies the exponential wait by 1.8. Jitter is up to 10% of the
current exponential delay, and the final wait never exceeds `maxDelayMs`. The
two delay fields survive `enable` and `disable` cycles.

A missing, unreadable, malformed or unknown-schema file is treated as `off`.
Typos fail loudly instead of silently changing your retry behaviour.

## How it works

The extension hooks the moment Pi has exhausted its own retries and is about to
settle the run. Only an error outcome can be retried. If the last assistant
message carries a transient provider error, it waits with exponential backoff,
then asks Pi for one more provider request with the same conversation.

The failed assistant message, and any tool results it produced, are omitted from
the model context first — the same recovery Pi performs on its own retries — so
the model never sees a half-written turn. No new user prompt is created and your
conversation is untouched.

The attempt counter resets on a completed turn, an abort, a non-transient
failure, a policy switch, or a session change.

## Troubleshooting

Known behaviours and fixes: **[docs/troubleshooting.md](docs/troubleshooting.md)**.

Most common surprises:

- Installed but silent → it is off; run `/gentle:retry enable`.
- Still stopping on a failure → it was classified as non-transient, on purpose.
- Project file ignored → it is malformed; `/gentle:retry status` says `malformed`.

## Development

```bash
pnpm install
pnpm run check     # TypeScript check
pnpm test          # builds to dist/, then runs the suite
pnpm run build     # build to dist/
```

The suite exercises the real `agent_before_settle` event shape and Pi's real
extension loader, so a green run means the built artifact loads and reads
provider errors the way Pi emits them.

Maintainers: release steps live in [docs/release.md](docs/release.md), and
changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
