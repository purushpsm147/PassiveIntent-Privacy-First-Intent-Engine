/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createContext } from 'react';
import type { UsePassiveIntentReturn } from './types.js';

/**
 * Internal React context for the shared IntentManager engine.
 *   null  → no PassiveIntentProvider in the component tree.
 *   value → the stable callbacks provided by the nearest PassiveIntentProvider.
 */
export const PassiveIntentContext = createContext<UsePassiveIntentReturn | null>(null);
PassiveIntentContext.displayName = 'PassiveIntentContext';
