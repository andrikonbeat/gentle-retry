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

Requirements: Pi Coding Agent 1.4.0 or newer, Node 22.19 or newer (Node 22 and
24 are verified in CI).

> `pnpm add -g gentle-retry` does not register an extension with Pi. Use
> `pi install`, or drop it under `~/.pi/agent/extensions/`.

## First run

The extension installs **off**. That is deliberate: an unlimited retry loop
should never switch itself on without you asking. The first time it loads in a
project it says so, once, and names the command that turns it on:

```
gentle-retry installed — OFF. Retries transient provider failures such as HTTP 429 and timeouts:
/gentle:retry enable keeps a run alive instead of stopping.
```

The notice appears once per machine and never again. Scripted and headless runs
never see it.

## Commands

See [Controls](#controls) for the complete command surface. In short:

```
/gentle:retry enable     # keep runs alive through transient provider failures
/gentle:retry disable    # back to Pi's own retry budget
/gentle:retry status     # effective state, source, limits, and pause state
/gentle:retry auto-resume on   # continue an interrupted turn when a session is reopened
/gentle:retry reconnect global # resume live sessions when the internet comes back
```

Run `/gentle:retry` without arguments and the whole surface appears in one
menu — `Gentle retry (current: on)` — so you never have to remember a flag.

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
| `autoResume` | `false` | Continue an interrupted turn when the session is reopened. |

Each attempt multiplies the exponential wait by 1.8. Jitter is up to 10% of the
current exponential delay, and the final wait never exceeds `maxDelayMs`. The
two delay fields survive `enable` and `disable` cycles.

A missing, unreadable, malformed or unknown-schema file is treated as `off`.
Typos fail loudly instead of silently changing your retry behaviour.

## Controls

The command surface is intentionally small:

```text
/gentle:retry enable [--global]
/gentle:retry disable [--global]
/gentle:retry status
/gentle:retry pause
/gentle:retry resume
/gentle:retry auto-resume on|off [--global]
/gentle:retry reconnect off|session|global|enable|disable
/gentle:retry doctor
```

Without arguments, `/gentle:retry` opens an interactive menu titled
`Gentle retry (current: on)` with every action: enable and disable per project
or globally, pause and resume for this session, the auto-resume switch, the
reconnect scope and session opt-in, the status, and the diagnostics. The
argument forms above stay available for scripts.

Without `--global`, `enable` and `disable` write the project policy. With
`--global`, they write the policy in the Gentle AI config home. A valid project
policy still takes precedence over the global one.

`pause` and `resume` affect only the current session. Pausing prevents retries
without changing the saved policy. `status` shows the effective policy, its
source, delay bounds, optional safety limits, pause state, and the auto-resume
switch. `doctor` adds configuration and installation diagnostics; it never
reads or prints credentials.

`auto-resume` is a separate, opt-in switch. When it is on and you reopen a
session whose last turn was interrupted — the terminal closed, the process was
killed — gentle-retry sends one continuation message so the run picks up where
it stopped. It never continues a turn that ended normally, that you aborted, or
that failed with a provider error, and it never continues the same turn twice.
Because a turn can die after a tool already ran, the continuation is
at-least-once: a side effect may repeat. That is why the switch is off by
default.

Optional safety limits are off by default. Add positive integers to the policy
file to cap a retry sequence:

```json
{
  "schema": "gentle-pi.retry/v1",
  "policy": "on",
  "baseDelayMs": 2000,
  "maxDelayMs": 60000,
  "maxAttempts": 20,
  "maxElapsedMs": 900000
}
```

`maxAttempts` caps extension retries in one sequence. `maxElapsedMs` caps the
elapsed retry sequence time. When either limit is reached, gentle-retry reports
it and stops instead of retrying. Omit either field to keep that dimension
unlimited.

## Reconnect after an outage

When the machine loses the internet, a provider call fails and the turn ends.
`reconnect` mode waits for the connectivity instead and resumes the work on
its own:

```bash
/gentle:retry reconnect global   # every live Pi session resumes when the network returns
/gentle:retry reconnect session  # only the sessions that opt in resume
/gentle:retry reconnect enable   # opt this session in (scope "session")
/gentle:retry reconnect disable  # opt this session out
/gentle:retry reconnect off      # turn the feature off for this project
```

`global` is written to the global policy: it reaches every Pi session on the
machine. `session` and `off` are written to the project policy, and a project
policy still takes precedence over the global one.

The feature is **off by default**, and it never changes what happens on a
healthy machine:

- A provider timeout while the computer still has internet stays a provider
  failure: the retry sequence owns it, with the same delay and the same
  attempts.
- Only a real outage changes the behaviour. The connectivity probe asks "can
  this machine reach the internet right now", and one failed probe is not
  enough: two consecutive failures are required, so the check may cost two
  small requests.
- While the machine is offline the turn waits (up to five minutes, Esc stops
  it) instead of ending, and that wait consumes no retry attempt.
- If that wait runs out, the turn ends and the session keeps watching in the
  background for up to an hour: it resumes by itself when the network comes
  back, and `/gentle:retry reconnect disable` stops the watch.
- When the connectivity returns, the same turn continues with the failed
  message left out. If the turn already ended, the work continues in a new run
  with one continuation message.
- Billing, authentication, and bad-request failures never wait: no amount of
  connectivity brings the quota back.
- One outage resumes at most three times, and a turn is never resumed twice.

A resumed turn can repeat a side effect that already ran (at-least-once), so
the switch is opt-in. Reconnect covers the sessions that are alive: a session
whose process already died is resumed by `auto-resume` when you reopen it.

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
