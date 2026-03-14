# Publishing Guide

Use this when cutting the next npm release from this repo.

Semver:

- major: breaking API or behavior changes
- minor: new backward-compatible features
- patch: bug fixes only

For the current correction, `@passiveintent/core` should move from the mistaken `1.0.1` to `1.1.0`.

## Release Checklist

1. Update the release notes in `CHANGELOG.md`.
2. Bump the package version you are releasing.
3. Update dependent package ranges only if compatibility changed.
4. Run the release checks.
5. Publish `@passiveintent/core` first.
6. Publish `@passiveintent/react` after core, if React is part of the release.
7. Verify npm and StackBlitz.

## Version Bumps

```bash
cd packages/core
npm version 1.1.0 --no-git-tag-version

cd ../react
npm version 1.1.0 --no-git-tag-version

cd ../..
npm install
```

Use exact versions if you are doing a lockstep release. Use `patch`, `minor`, or `major` only when you want npm to calculate the next version for you.

## What To Update

- `packages/core/package.json`
- `packages/react/package.json`
- `package-lock.json`
- `CHANGELOG.md`

Update these only when needed for compatibility or StackBlitz:

- `demo/package.json`
- `demo-react/package.json`

## Demo / StackBlitz Rules

- minor or patch core release: no `demo/package.json` change is needed because `@passiveintent/core` is already `^1.0.0`, which accepts later `1.x` versions
- minor or patch React release: no `demo-react/package.json` change is needed because both package ranges are already `^1.0.0`
- major core release: update `demo/package.json` to `@passiveintent/core@^X.0.0`
- major React release: update `demo-react/package.json` to `@passiveintent/core@^X.0.0` and `@passiveintent/react@^X.0.0`
- if `@passiveintent/react` starts requiring a newer minimum core minor, update `demo-react/package.json` and `packages/react/package.json` to that minimum compatible range

Practical rule:

- StackBlitz does not care about the demo app's own `version`
- StackBlitz only cares that the dependency ranges in `demo/package.json` and `demo-react/package.json` can resolve the published npm packages
- for normal `1.x` minor and patch releases, the existing `^1.0.0` ranges are enough
- only change the demo dependency ranges when the published package compatibility range changes

## Release Checks

```bash
npm whoami
npm ci
npm run typecheck
npm run test
npm run build
npm run verify:package -w @passiveintent/core
npm pack --dry-run -w @passiveintent/react
```

Run these too if the release touched those areas:

```bash
npm run test:e2e -w @passiveintent/core
npm run test:perf:all -w @passiveintent/core
```

## Publish Order

```bash
cd packages/core
npm publish
npm view @passiveintent/core version

cd ../react
npm publish
npm view @passiveintent/react version
```

Publish React only if it changed.

## Finish

```bash
git add CHANGELOG.md package-lock.json packages/core/package.json packages/react/package.json demo/package.json demo-react/package.json
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

Trim the `git add` list if some packages were not part of the release.

## If You Published The Wrong Version

Do not republish the same version.

Use npm metadata instead:

```bash
npm dist-tag add `@passiveintent/core`@1.1.0 latest
npm deprecate `@passiveintent/core`@1.0.1 "Incorrect semver. Use >=1.1.0 instead."
```
