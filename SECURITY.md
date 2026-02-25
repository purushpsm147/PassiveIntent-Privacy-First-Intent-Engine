<!--
  Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# Security Policy

## Supported Versions

Only the latest stable release of the EdgeSignal SDK receives security fixes.
Please upgrade to the latest version before reporting a vulnerability.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

---

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

A public issue immediately discloses the flaw to every user of the repository — including potential attackers — before a fix is available. We ask you to follow a responsible disclosure process instead.

### How to Report

Send an email to:

**purushpsm147@yahoo.co.in**

Please include all of the following in your report:

1. **Description** — A clear explanation of the vulnerability and its potential impact.
2. **Affected versions** — Which SDK version(s) are affected.
3. **Proof of concept** — A minimal, self-contained script or set of steps that reliably demonstrates the issue.
4. **Environment details** — Browser/runtime version, OS, and any other relevant context.
5. **Suggested fix** (optional) — If you have a proposed remediation, we welcome it.

Encrypt sensitive details using our PGP public key if you prefer (key available on request).

### What to Expect

| Timeline           | Action                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Within **48 h**    | We acknowledge receipt of your report.                                                            |
| Within **7 days**  | We provide an initial assessment and severity rating (CVSS score).                                |
| Within **90 days** | We aim to release a patch and publish a CVE (if applicable). We will keep you updated throughout. |

We will coordinate the public disclosure date with you. If you require more time before public disclosure (e.g., for your own advisory), please say so in your report.

### Bug Bounty

We do not currently operate a paid bug bounty program. We do, however, credit all reporters (with your permission) in the release notes and security advisory for the fix.

---

## Scope

The following are **in scope** for security reports:

- The `edge-signal` npm package (`src/`)
- The public SDK API surface (`IntentManager`, adapters, configuration)
- Data leakage or privacy violations stemming from SDK behaviour

The following are **out of scope**:

- Vulnerabilities in third-party dependencies (please report those upstream)
- Issues in the sandbox/demo app (`sandbox/`) that do not affect SDK consumers
- Social engineering or phishing attacks
- Denial-of-service attacks that require an authenticated position

---

## Disclosure Policy

We follow the [Google Project Zero 90-day disclosure policy](https://googleprojectzero.blogspot.com/p/vulnerability-disclosure-faq.html). If a patch cannot be delivered within 90 days, we will publish a mitigation advisory and negotiate an extension with the reporter.

---

## Hall of Fame

We thank the following researchers for responsible disclosures:

_(No disclosures yet — be the first!)_
