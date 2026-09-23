import type { ReactNode } from 'react';

import { SOURCE_LOCALE } from '@/i18n/config';
import { I18nProvider } from '@/i18n/I18nProvider';

import './globals.css';

// No static `metadata.title`: the document and window titles are set from i18n by
// I18nProvider, so they follow the active locale like every other visible string.
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang={SOURCE_LOCALE}>
      <body className="antialiased">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
