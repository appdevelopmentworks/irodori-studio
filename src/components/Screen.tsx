import type { ReactNode } from 'react';

import { Spinner } from './icons';

/** Centered card used by the pre-app screens (setup, startup, errors). */
export function Screen({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900`}
      >
        {children}
      </div>
    </main>
  );
}

/** Text-free placeholder while the locale is not known yet (avoids a flash of `ja`). */
export function Splash() {
  return (
    <main className="flex min-h-screen items-center justify-center text-zinc-400">
      <Spinner className="h-8 w-8" />
    </main>
  );
}
