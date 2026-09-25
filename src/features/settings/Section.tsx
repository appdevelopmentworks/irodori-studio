import type { ReactNode } from 'react';

import { card } from '@/components/ui';

/** One card of the Settings screen. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${card} space-y-3`}>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="text-xs text-zinc-500">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
