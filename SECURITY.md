# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Send the details to
Andrik <andrik.sc02@gmail.com> with:

- what the problem is and what an attacker gains,
- the steps to reproduce it, and
- the version of `gentle-retry` and of Pi you tested it with.

You will get an acknowledgement, and a fix or a mitigation plan, before the
report becomes public.

## What this extension touches

`gentle-retry` runs inside a Pi session. It reads and writes two policy files
— one under the project (`.pi/gentle-ai/retry-policy.json`) and one under the
config home (`~/.pi/gentle-ai/retry-policy.json`) — plus small marker files
that record a resumed turn. It sends no telemetry, contacts no third-party
service except the npm registry ping used to detect that the network came back,
and never changes the provider credentials.
