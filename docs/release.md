# Release process

Maintainer notes. A release is a deliberate act performed by a human; nothing in
this repository publishes on its own.

## Before any release

The gate is green evidence, not confidence:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
node scripts/verify-package.mjs
```

CI runs the source checks, tests, build, and packed-artifact verification on
Node 22 and Node 24. A release does not start while any of them is red.

## Version

1. Pick the version with [Semantic Versioning](https://semver.org/):
   - `patch` — a fix that changes no behaviour someone depends on.
   - `minor` — a new option, command or behaviour, backward compatible.
   - `major` — a change that breaks an existing install or config file.
2. Update `version` in `package.json`.
3. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
   `## [x.y.z] - YYYY-MM-DD` heading, and update the two link definitions at the
   bottom.

## Supported runtime and host

The package engine range is `^22.19.0 || ^24.0.0`. It keeps Pi's Node
`>=22.19.0` host minimum and supports the same Node 22 and Node 24 lines that
CI verifies. Other Node lines, including Node 26, are intentionally excluded
until the type check, test suite, and packed-artifact verification pass
reliably on them.

The extension peer dependency is `@earendil-works/pi-coding-agent: ^1.4.0`.
This accepts the installed and verified Pi 1.4.0 release, allows compatible 1.x
updates, and excludes unverified future majors.

## Verify the artifact, not the source tree

A published package that installs but does nothing is the failure mode this
section exists to catch. The release verifier creates the real npm tarball,
extracts it, and checks the bytes that the registry would serve:

```bash
pnpm run build
node scripts/verify-package.mjs
```

The verifier packs the project without running lifecycle scripts, extracts the
result, and checks that the packed `package.json` contains the `pi.extensions`
entry for `./dist/extension.js`. It imports that file from the extracted
tarball, requires its default export to be a function, and confirms that the
packed public instructions contain the exact install command. Run the build
first so the verifier inspects the current source revision:

```bash
pi install npm:gentle-retry
```

## Publish

Publishing requires the maintainer's own registry session:

```bash
npm login            # human step, never automated
npm whoami           # must print the account that owns the name
npm publish --access public
```

Rules:

- The package name is `gentle-retry`. Do not publish under a different name
  without updating every install instruction that names it.
- `npm publish` refuses to run if `pnpm run check` or `pnpm test` fails, because
  `prepublishOnly` runs them.
- Publishing is a separate human-authorized action. CI has no publish step and
  must not receive npm registry credentials.
- Do not publish from a dirty working tree. Commit and tag first, so the
  published bytes have a recorded origin.

## After publish

```bash
git tag v<version>
git push origin main --tags
npm view gentle-retry version
```

Then prove the user path works from the registry, not from the local checkout:

```bash
pi install npm:gentle-retry
```

## If something is wrong with a published version

`npm unpublish` is destructive and, for versions older than 72 hours, mostly
refused. Prefer `npm deprecate gentle-retry@<bad-version> "<reason>"` and publish
a fixed version. The deprecation message is what every user will read on install.
