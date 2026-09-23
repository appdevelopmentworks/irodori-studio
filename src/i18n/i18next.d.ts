// Typed translation keys: `t()` only accepts keys that exist in the source locale,
// so `tsc --noEmit` (npm run lint) rejects typos and missing `ja` keys.
import 'i18next';

import type { resources } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: (typeof resources)['ja'];
  }
}
