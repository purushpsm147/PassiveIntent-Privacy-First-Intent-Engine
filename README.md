<!--
  Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# EdgeSignal — Monorepo

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg)](https://www.typescriptlang.org/)
[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz_small.svg)](https://stackblitz.com/github/purushpsm147/EdgeSignal-Privacy-First-Intent-Engine)

This repository is structured as an **npm workspaces monorepo** containing all EdgeSignal packages.

---

## Packages

| Package                                 | Version                                                                                                                                    | Description                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| [`@edgesignal/core`](./packages/core)   | [![npm](https://img.shields.io/badge/npm-coming%20soon-lightgrey)](https://github.com/purushpsm147/EdgeSignal-Privacy-First-Intent-Engine) | Privacy-first, on-device behavioral intent engine |
| [`@edgesignal/react`](./packages/react) | [![npm](https://img.shields.io/badge/npm-coming%20soon-lightgrey)](https://github.com/purushpsm147/EdgeSignal-Privacy-First-Intent-Engine) | React 18+ hook wrapper for `@edgesignal/core`     |

Full documentation for each package lives inside the package directory:

- **Core library** — [packages/core/README.md](./packages/core/README.md)
- **React hook** — [packages/react/README.md](./packages/react/README.md)
- **Architecture & API deep-dive** — [packages/core/docs/architecture.md](./packages/core/docs/architecture.md)

---

## Repository layout

```
.
├── package.json               # monorepo root — npm workspaces
├── tsconfig.base.json         # shared TypeScript base config
├── .prettierrc
├── .editorconfig
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── PRICING.md
├── FUTURE_FEATURES.md
├── BINARY_CODEC_SPEC.md
├── LICENSE
├── .github/
│   ├── CODEOWNERS
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
│       ├── ci.root.yml        # format:check (all packages)
│       ├── ci.core.yml        # build / test / perf for @edgesignal/core
│       ├── ci.react.yml       # build / test for @edgesignal/react
│       ├── release-gate.yml   # full pre-release validation gates
│       └── perf-matrix.core.yml
└── packages/
    ├── core/                  # published as @edgesignal/core
    └── react/                 # published as @edgesignal/react
```

---

## Root scripts

| Script                 | Description                    |
| ---------------------- | ------------------------------ |
| `npm run build`        | Build all packages             |
| `npm run typecheck`    | Type-check all packages        |
| `npm run test`         | Test all packages              |
| `npm run format`       | Format all files with Prettier |
| `npm run format:check` | Check formatting (CI)          |

Run workspaces individually to target a single package:

```bash
npm run build --workspace=@edgesignal/core
npm run test  --workspace=@edgesignal/core
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines and [SECURITY.md](./SECURITY.md) for security disclosures.

---

## License

EdgeSignal is dual-licensed — see [LICENSE](./LICENSE) and [PRICING.md](./PRICING.md) for details.
