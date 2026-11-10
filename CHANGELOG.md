# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Coverage for connection failures, HTTP 502, incomplete streams, and the named
  degraded-function HTTP 400 condition; generic HTTP 400 remains non-transient.
- Optional `Retry-After` support, capped by `maxDelayMs`.
- Global policy controls, session-scoped pause and resume, detailed status, and
  installation diagnostics through `/gentle:retry doctor`.
- Optional `maxAttempts` and `maxElapsedMs` safety limits, disabled by default.

### Changed

- Only boundaries with outcome `error` are retried; completed and aborted
  boundaries now reset the attempt counter.
- Retry backoff keeps factor 1.8 while applying jitter proportionally to the
  current exponential delay.
- Malformed, unreadable, or unknown-schema project policies fail closed, and
  policy and onboarding writes use atomic replacement beside the destination.

### Fixed

- Policy and onboarding writes no longer fail with `EXDEV` when the destination
  is on a different filesystem from the operating-system temporary directory.

## [0.1.0] - 2026-11-02

First public release.

### Added

- Unlimited retry on HTTP 429 and timeout for Pi Coding Agent and Gentle Shell,
  after the host's own retry budget is exhausted.
- Failure classification that retries only transient causes and never retries
  quota, billing, authentication or any other non-transient error.
- Exponential backoff with jitter, from `baseDelayMs` (default 2000) up to
  `maxDelayMs` (default 60000), interruptible with Escape.
- Omitting the failed assistant message, and the tool results it produced, from
  the model context before the follow-up request.
- `/gentle:retry` command with `enable`, `disable` and `status`.
- Project and global configuration files, with the project file taking
  precedence and a fail-closed default of `off`.
- Guard against late events from a replaced or reloaded session.

[Unreleased]: https://github.com/andrikonbeat/gentle-retry/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/andrikonbeat/gentle-retry/releases/tag/v0.1.0
