/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pre-compiled patterns for dynamic path-segment detection.
 *
 * Both regexes are compiled **once at module load time** so that every
 * `normalizeRouteState()` call is allocation-free on the hot path.
 */

/**
 * Matches a v4 UUID in its canonical 8-4-4-4-12 hex form.
 *
 * Version constraint:  the third group starts with `4` (version bit).
 * Variant constraint:  the fourth group starts with `8`, `9`, `a`, or `b`
 *                      (RFC 4122 variant bits).
 * Case-insensitive:    both upper- and lower-case hex digits are accepted.
 */
const UUID_V4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/**
 * Matches a MongoDB ObjectID: exactly 24 hexadecimal characters forming a
 * complete word (no adjoining word characters on either side).
 *
 * The `\b` word-boundary anchors prevent partial matches inside longer hex
 * strings (e.g. a 26-char string is not accidentally truncated).
 * Case-insensitive so both lowercase storage and uppercase display variants
 * are handled.
 */
const MONGO_ID_RE = /\b[0-9a-f]{24}\b/gi;

/**
 * Matches a path segment that is a purely numeric integer ID with 4 or more
 * digits.  The threshold of 4 avoids stripping common low-value segments
 * like `/page/2` (pagination) or `/step/3` (wizard steps).
 *
 * Pattern breakdown:
 *   `\/`        — must be preceded by a slash (path separator)
 *   `\d{4,}`   — four or more consecutive digits
 *   `(?=\/|$)` — followed by another slash or end-of-string (segment boundary)
 *
 * Global flag: multiple numeric segments in one path are all replaced.
 */
const NUMERIC_ID_RE = /\/\d{4,}(?=\/|$)/g;

/**
 * Normalizes a URL or route path to a canonical state key for use as an
 * `IntentManager` state label.
 *
 * Transformations applied in order:
 *
 * 1. **Strip query string** — everything from the first `?` onwards is removed.
 * 2. **Strip hash fragment** — everything from the first `#` onwards is removed.
 * 3. **Replace dynamic ID segments** — v4 UUIDs, 24-character hex MongoDB
 *    ObjectIDs, and numeric IDs with 4+ digits found anywhere in the remaining
 *    path are replaced with `:id`.
 * 4. **Remove trailing slash** — a single trailing `/` is removed so that
 *    `/checkout/` and `/checkout` resolve to the same state.  The bare root
 *    path `/` is left unchanged.
 *
 * The function is **pure**: identical inputs always produce identical outputs
 * and it has no side-effects.  All regex patterns are compiled once at module
 * load time so the per-call cost is limited to string scanning.
 *
 * @example
 * normalizeRouteState('/users/550e8400-e29b-41d4-a716-446655440000/profile?tab=bio#section')
 * // → '/users/:id/profile'
 *
 * @example
 * normalizeRouteState('/products/507f1f77bcf86cd799439011/reviews/')
 * // → '/products/:id/reviews'
 *
 * @example
 * normalizeRouteState('/user/12345/profile')
 * // → '/user/:id/profile'
 *
 * @example
 * normalizeRouteState('/checkout/')
 * // → '/checkout'
 *
 * @param url - A URL string or path, e.g. from `window.location.href` or
 *              `window.location.pathname`.
 * @returns    The normalized, canonical route state string.
 */
export function normalizeRouteState(url: string): string {
  // 1. Strip query string — slice at the first '?'
  const qIdx = url.indexOf('?');
  let path = qIdx !== -1 ? url.slice(0, qIdx) : url;

  // 2. Strip hash fragment — slice at the first '#'
  const hIdx = path.indexOf('#');
  if (hIdx !== -1) path = path.slice(0, hIdx);

  // 3. Replace v4 UUIDs first (more specific), then MongoDB ObjectIDs,
  //    then numeric IDs (4+ digit path segments).
  //    UUID replacement runs first because a UUID may contain 24-char hex
  //    sub-sequences that would otherwise be caught by the ObjectID regex.
  path = path.replace(UUID_V4_RE, ':id').replace(MONGO_ID_RE, ':id').replace(NUMERIC_ID_RE, '/:id');

  // 4. Remove a single trailing slash, but preserve the bare root '/'.
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path;
}
