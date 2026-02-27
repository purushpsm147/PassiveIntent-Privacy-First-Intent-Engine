<!--
  Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# Contributing to PassiveIntent

PassiveIntent is dual-licensed (AGPLv3 + Commercial). To keep the IP
chain legally clean for both tiers, **all code PRs require signing our CLA**
before merging. The CLA bot prompts you automatically on your first PR.

---

## Why We Require a CLA

PassiveIntent sells commercial licenses that exempt paying customers from
AGPLv3 copyleft obligations. To legally include your contribution in those
commercial builds, we need your explicit permission — that's what the CLA does.

**What the CLA does:**

- Grants PassiveIntent the right to include your contribution in both the
  AGPLv3 (free) and commercial (paid) versions.
- Confirms you have the legal right to submit the code.

**What the CLA does NOT do:**

- Transfer copyright — you retain full ownership.
- Prevent you from using your own code elsewhere.

Signing takes 30 seconds via GitHub. This model is used by MongoDB,
Elastic, Qt, and every major dual-licensed open-source project.

---

## What We Accept

| Contribution                         | Accepted?        | Notes                          |
| ------------------------------------ | ---------------- | ------------------------------ |
| Bug fixes (with failing test)        | ✅ Yes           | CLA required                   |
| Documentation improvements           | ✅ Yes           | CLA required                   |
| Performance optimisations            | ✅ Yes           | CLA + benchmark proof required |
| New framework adapters (Vue, Svelte) | ⚠️ Discuss first | Open an Issue first            |
| New core algorithms / features       | ⚠️ Discuss first | Open an Issue before coding    |
| New runtime dependencies             | ❌ No            | Zero-dependency by design      |

---

## How to Contribute

1. **Open an Issue first** for anything beyond a trivial fix
2. Fork the repo, create a branch: `git checkout -b fix/your-description`
3. Run `npm run format` — Prettier is enforced in CI
4. Add or update tests — PRs without tests will not be merged
5. Run the full suite locally:
   ```bash
   npm run typecheck && npm run test && npm run format:check
   ```

---

## What to expect after opening a PR

- **The CLA Bot:** Will ask for your signature.

- **Automated AI Review:** We use CodeRabbit to do an initial pass for memory leaks, XSS vulnerabilities, and performance bottlenecks. Please don't be offended if the bot leaves a critique! It's configured to be strict about our performance invariants.

- **Human Review:** Once the CI passes and the CLA is signed, the core team will review your PR.
