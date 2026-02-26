# `@passiveintent/react`

> React 18+ wrapper for [`@passiveintent/core`](../core/README.md) — drop-in `usePassiveIntent` hook with Strict Mode safety and SSR support.

---

## Installation

```bash
npm install @passiveintent/react
# react / react-dom are peer dependencies — install once at app level
```

---

## Quick Start

```tsx
'use client'; // Next.js App Router
import { usePassiveIntent } from '@passiveintent/react';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

export function TrackingProvider({ children }: { children: React.ReactNode }) {
  const { track, on, getTelemetry } = usePassiveIntent({
    botProtection: true,
    eventCooldownMs: 60_000,
  });

  const pathname = usePathname();

  useEffect(() => {
    track(pathname);
  }, [pathname, track]);

  useEffect(() => {
    return on('high_entropy', () => {
      console.log('[PassiveIntent] anomaly', getTelemetry());
    });
  }, [on, getTelemetry]);

  return <>{children}</>;
}
```

---

## API

### `usePassiveIntent(config: IntentManagerConfig): UsePassiveIntentReturn`

All returned methods are stable across re-renders (`useCallback(…, [])`). Methods are no-ops
before the first mount (SSR, Suspense, concurrent transitions) and after unmount.

| Method              | Signature                                                             | Notes                                                           |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `track`             | `(event: string) => void`                                             | Records a page-view or custom event                             |
| `on`                | `(event, handler) => () => void`                                      | Subscribe; call the returned function to unsubscribe            |
| `getTelemetry`      | `() => PassiveIntentTelemetry`                                        | Full engine snapshot                                            |
| `predictNextStates` | `(threshold?, sanitize?) => { state: string; probability: number }[]` | Top-N Markov predictions                                        |
| `hasSeen`           | `(route: string) => boolean`                                          | Bloom filter membership test                                    |
| `incrementCounter`  | `(key: string, by?: number) => number`                                | Exact session-scoped counter; returns new value, `0` during SSR |
| `getCounter`        | `(key: string) => number`                                             | Read a session-scoped counter                                   |
| `resetCounter`      | `(key: string) => void`                                               | Reset a session-scoped counter                                  |

---

## Design Notes

- **Strict Mode safe** — `IntentManager` is held in `useRef`; the empty-dep `useEffect` creates and destroys it once per real mount.
- **SSR safe** — `typeof window !== 'undefined'` guard prevents instantiation in Node.js / edge runtimes.
- **Config stability** — `configRef` captures the initial config; later re-renders do not re-initialize the instance.

---

## Monorepo Package Conventions

All `@passiveintent/*` packages follow these conventions:

```
packages/<name>/
  package.json       → "name": "@passiveintent/<name>"
  tsconfig.json      → extends ../../tsconfig.base.json
  src/
    index.ts         → primary export surface
  README.md          → this file pattern
```

- `@passiveintent/core` dependency: pin to the corresponding release range (e.g. `"^1.0.0"`).
- Build: `tsup src/index.ts --format esm,cjs --dts --sourcemap`
- Types: dual `d.ts` via `tsup --dts`

See [architecture.md](../core/docs/architecture.md#framework-packages) for the full framework packages roadmap.
