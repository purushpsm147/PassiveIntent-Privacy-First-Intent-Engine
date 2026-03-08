<!--
  Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# PassiveIntent — Monorepo

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg)](https://www.typescriptlang.org/)
[![CLA assistant](https://cla-assistant.io/readme/badge/passiveintent/core)](https://cla-assistant.io/passiveintent/core)
[![npm @passiveintent/core](https://img.shields.io/npm/v/@passiveintent/core.svg)](https://www.npmjs.com/package/@passiveintent/core)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/@passiveintent/core)](https://bundlephobia.com/package/@passiveintent/core)
[![npm @passiveintent/react](https://img.shields.io/npm/v/@passiveintent/react.svg)](https://www.npmjs.com/package/@passiveintent/react)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/@passiveintent/react)](https://bundlephobia.com/package/@passiveintent/react)
[![Open Vanilla demo in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz_small.svg)](https://stackblitz.com/github/passiveintent/core/tree/main/demo)
[![Open React demo in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz_small.svg)](https://stackblitz.com/github/passiveintent/core/tree/main/demo-react)

**Website:** [passiveintent.dev](https://passiveintent.dev)

This repository is structured as an **npm workspaces monorepo** containing all PassiveIntent packages.

---

## Packages

| Package                                    | Version                                                                                                   | Description                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`@passiveintent/core`](./packages/core)   | [![npm](https://img.shields.io/npm/v/@passiveintent/core.svg)](https://www.npmjs.com/package/@passiveintent/core)   | Privacy-first, on-device behavioral intent engine |
| [`@passiveintent/react`](./packages/react) | [![npm](https://img.shields.io/npm/v/@passiveintent/react.svg)](https://www.npmjs.com/package/@passiveintent/react) | React 18+ hook wrapper for `@passiveintent/core`  |

Full documentation for each package lives inside the package directory:

- **Core library** — [packages/core/README.md](./packages/core/README.md)
- **React hook** — [packages/react/README.md](./packages/react/README.md)
- **Architecture & API deep-dive** — [packages/core/docs/architecture.md](./packages/core/docs/architecture.md)

---

## Repository layout

```
.
├── package.json               # monorepo root — npm workspaces
├── package-lock.json
├── tsconfig.base.json         # shared TypeScript base config
├── .prettierrc
├── .prettierignore
├── .editorconfig
├── .gitignore
├── coderabbit.yaml
├── BINARY_CODEC_SPEC.md
├── CALIBRATION_GUIDE.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── FUTURE_FEATURES.md
├── LICENSE
├── PRICING.md
├── PUBLISHING.md
├── README.md
├── SECURITY.md
├── .github/
│   ├── CODEOWNERS
│   ├── FUNDING.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
│       ├── ci.root.yml        # format:check (all packages)
│       ├── ci.core.yml        # build / test / perf for @passiveintent/core
│       ├── ci.react.yml       # build / test for @passiveintent/react
│       ├── release-gate.yml   # full pre-release validation gates
│       └── perf-matrix.core.yml
├── demo/                      # vanilla JS demo app
├── demo-react/                # React demo app
├── landing/                   # landing page (passiveintent.dev)
└── packages/
    ├── core/                  # published as @passiveintent/core
    └── react/                 # published as @passiveintent/react
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
npm run build --workspace=@passiveintent/core
npm run test  --workspace=@passiveintent/core
```

---

## 🎯 The Enterprise Calibration Engine

Generic intent libraries ship with hardcoded thresholds tuned on someone else's data. A fixed `logLikelihood < -2.0` cutoff that works on a DTC checkout funnel is noise on a B2B SaaS dashboard — and an alert storm on a high-traffic media site.

PassiveIntent's statistical model is different. It normalizes every anomaly score against **your site's own observed log-likelihood distribution**, computed from real production sessions:

$$Z = \frac{LL_{observed} - \mu_{your\,site}}{\sigma_{your\,site}}$$

A Z-score of `-2.0` means the same thing on every deployment: _two standard deviations below your site's own normal_. An enterprise SaaS with low behavioral variance and a media site with high variance both produce reliable, low-false-positive signals — without you touching a single threshold.

The calibration system rests on three pillars:

| Pillar                      | What it solves                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Domain Baseline**         | Trains the Markov model on your site's unique navigation topology (linear funnel vs. cyclical dashboard).                |
| **Statistical Calibration** | Extracts your site's `baselineMeanLL` and `baselineStdLL` so Z-score thresholds are portable across any traffic profile. |
| **Intervention Mapping**    | Wires mathematical anomalies to concrete, timed business actions — chat escalation, discount triggers, prefetch hints.   |

**→ Read the full guide:** [CALIBRATION_GUIDE.md](./CALIBRATION_GUIDE.md)

---

## 🔒 Enterprise-Grade Privacy & Security

PassiveIntent flips the traditional analytics threat model. By executing entirely in the browser, it provides **Zero Egress** behavioral tracking.

- **Zero Network Egress:** The engine does not make HTTP requests. Behavioral data never leaves the user's device, making Man-in-the-Middle (MitM) interception impossible.
- **Cryptographic Irreversibility:** We do not store browsing history. State visits are hashed into a fixed-size Bloom Filter using FNV-1a. Even if a host application suffers an XSS attack, the stolen memory payload cannot be reverse-engineered into a list of visited URLs.
- **PII Eradication:** The native `RouteNormalizer` aggressively strips UUIDs, MongoDB ObjectIDs, and query strings before any math occurs, ensuring no Personally Identifiable Information ever enters the Markov matrix.
- **GDPR & CCPA Safe:** Because no PII is stored and no data is transmitted to third-party servers, PassiveIntent operates entirely outside the scope of traditional cookie-consent and data-processing liabilities.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines and [SECURITY.md](./SECURITY.md) for security disclosures.

---

## License

PassiveIntent is dual-licensed — see [LICENSE](./LICENSE) and [PRICING.md](./PRICING.md) for details.
