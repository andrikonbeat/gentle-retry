# Release process

Maintainer notes. A release is a deliberate act performed by a human; nothing in
this repository publishes on its own.

## Before any release

The gate is green evidence, not confidence:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm test
npm pack --dry-run
```

CI runs the same commands on node 22 and 24. A release does not start while any
of them is red.

## Version

1. Pick the version with [Semantic Versioning](https://semver.org/):
   - `patch` — a fix that changes no behaviour someone depends on.
   - `minor` — a new option, command or behaviour, backward compatible.
   - `major` — a change that breaks an existing install or config file.
2. Update `version` in `package.json`.
3. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
   `## [x.y.z] - YYYY-MM-DD` heading, and update the two link definitions at the
   bottom.

## Verify the artifact, not the source tree

A published package that installs but does nothing is the failure mode this
section exists to catch. Pack, unpack, and load the artifact the registry would
serve:

```bash
npm pack                                  # gentle-retry-<version>.tgz
tar -tzf gentle-retry-<version>.tgz | grep -E 'package/(dist/extension\.js|package\.json)'
mkdir -p /tmp/gr-check && tar -xzf gentle-retry-<version>.tgz -C /tmp/gr-check
node -e "import('/tmp/gr-check/package/dist/extension.js').then(m => console.log('default export:', typeof m.default))"
```

The last command must print `default export: function`. The `pi` entry in
`package.json` points at `./dist/extension.js`, so a missing `dist/` means the
package installs and stays inert. `prepack` builds it; a tarball packed with
`--ignore-scripts` will not have it.

Finally, load it the way a user would, from the extracted directory:

```bash
pi -e /tmp/gr-check/package
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
