# Publishing Guide — `@passiveintent/*` packages

Step-by-step instructions for publishing `@passiveintent/core` and `@passiveintent/react` to npm,
and activating the StackBlitz interactive demo.

---

## Table of Contents

1. [One-time npm account setup](#1-one-time-npm-account-setup)
2. [Pre-publish checklist](#2-pre-publish-checklist)
3. [Publish `@passiveintent/core`](#3-publish-passiveintentcore)
4. [Publish `@passiveintent/react`](#4-publish-passiveintentreact)
5. [Verify the published packages](#5-verify-the-published-packages)
6. [Activate the StackBlitz demo](#6-activate-the-stackblitz-demo)
7. [Future releases (patch / minor / major)](#7-future-releases)

---

## 1. One-time npm account setup

If you haven't already, log in to npm in your terminal:

```bash
# Login (opens browser for 2FA if enabled)
npm login

# Verify you are logged in as the right user
npm whoami
# → purushpsm147  (your npm username)
```

> **Important:** `@passiveintent` is a **scoped package**. By default npm treats scoped packages as private
> and requires a paid plan. The `"publishConfig": { "access": "public" }` field already added to both
> `package.json` files overrides this — no paid plan needed for open-source packages.

---

## 2. Pre-publish checklist

Run these from the repo root before every publish:

```bash
# 1. Ensure all tests pass
npm run test --workspaces --if-present

# 2. Verify TypeScript compiles cleanly
npm run typecheck --workspaces --if-present

# 3. Dry-run: inspect exactly what files will be uploaded
cd packages/core
npm pack --dry-run

cd ../react
npm pack --dry-run
```

**What to look for in `npm pack --dry-run`:**  
✓ Only `dist/` files are listed (no `src/`, no test files)  
✓ `README.md` and `LICENSE` are included  
✓ Total packed size is reasonable (core ≈ 25–40 kB packed)

---

## 3. Publish `@passiveintent/core`

```bash
cd packages/core

# (Optional) Create a local tarball first to inspect it
npm run release:pack
# → creates passiveintent-core-1.0.0.tgz for inspection

# Publish to npm
# prepublishOnly script runs "npm run build" automatically
npm publish
```

**Expected output:**

```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
+ @passiveintent/core@1.0.0
```

**Verify it is live:**

```bash
npm view @passiveintent/core
# should show version, description, dist-tags: latest → 1.0.0
```

---

## 4. Publish `@passiveintent/react`

> `@passiveintent/react` lists `@passiveintent/core` as a **peerDependency**, so publish core first.

```bash
cd ../react   # or: cd packages/react from root

npm run release:pack    # optional inspection
npm publish
```

**Verify:**

```bash
npm view @passiveintent/react
```

---

## 5. Verify the published packages

### Install in a throw-away project

```bash
mkdir /tmp/pi-smoke-test && cd /tmp/pi-smoke-test
npm init -y
npm install @passiveintent/core

# Quick smoke test
node -e "
const { IntentManager, BloomFilter, MarkovGraph } = require('@passiveintent/core');
const intent = new IntentManager({ storageKey: 'test' });
intent.track('/home');
intent.track('/pricing');
console.log('Predictions:', intent.predictNextStates(0.0));
console.log('hasSeen /home:', intent.hasSeen('/home'));
intent.destroy();
console.log('✓ All good');
"
```

### Check bundlephobia

Visit: https://bundlephobia.com/package/@passiveintent/core  
Target: **≤ 11 kB minzipped** (current: ~10.9 kB gzip, ~9.8 kB brotli)

### Check npm page

Visit: https://www.npmjs.com/package/@passiveintent/core  
Confirm: version, description, README, keywords, license (AGPL-3.0-only) all look correct.

---

## 6. Activate the StackBlitz demo

Once `@passiveintent/core@1.0.0` is live on npm the demo folder (`demo/`) is immediately runnable on StackBlitz
because its `package.json` references `"@passiveintent/core": "^1.0.0"`.

### Push the demo to GitHub

```bash
# From repo root — commit the demo folder
git add demo/ packages/core/package.json packages/react/package.json packages/core/README.md
git commit -m "feat: add interactive StackBlitz demo + publish config"
git push origin main
```

### Open in StackBlitz

The StackBlitz URL is already embedded in the README badge:

```
https://stackblitz.com/github/purushpsm147/PassiveIntent-Privacy-First-Intent-Engine/tree/main/demo
```

Click it (or share it) — StackBlitz will:

1. Clone the `demo/` subfolder
2. Run `npm install` (pulls `@passiveintent/core` from npm)
3. Start `vite` via the `.stackblitzrc` `startCommand`
4. Open the browser preview automatically

### Share the demo

Use the short StackBlitz share URL that appears in the browser bar after the project opens, e.g.:

```
https://stackblitz.com/edit/passiveintent-demo
```

Add this to your README, landing page, and product hunt post.

---

## 7. Future releases

### Patch release (bug fix)

```bash
# From packages/core
npm version patch   # 1.0.0 → 1.0.1
npm publish

# From packages/react (if changed)
npm version patch
npm publish
```

### Minor release (new feature, backward-compatible)

```bash
npm version minor   # 1.0.0 → 1.1.0
npm publish
```

### Major release (breaking change)

```bash
npm version major   # 1.0.0 → 2.0.0
npm publish
```

> `npm version` automatically creates a git commit + tag. Push with:
>
> ```bash
> git push --follow-tags
> ```

### Update the StackBlitz demo after a release

The demo's `package.json` uses `"^1.0.0"` so minor/patch updates are picked up automatically.
For major version bumps, update the pinned range:

```bash
cd demo
npm install @passiveintent/core@^2.0.0
git add . && git commit -m "demo: update to core v2"
git push
```

---

## Troubleshooting

| Error                                                    | Fix                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `402 Payment Required`                                   | The `publishConfig.access: "public"` is missing — already fixed in this repo.                    |
| `403 Forbidden`                                          | Wrong npm account logged in. Run `npm whoami` and `npm login`.                                   |
| `ENEEDAUTH`                                              | Run `npm login` first.                                                                           |
| `E404 Not Found` on peerDep                              | Publish `@passiveintent/core` before `@passiveintent/react`.                                     |
| StackBlitz shows `Module not found: @passiveintent/core` | The package isn't on npm yet. Publish first, then open the StackBlitz URL.                       |
| `dist/` not found                                        | Run `npm run build` in `packages/core` before packing. `prepublishOnly` does this automatically. |
