'use client';

import { useTranslation } from 'react-i18next';

import { formatMemory } from '@/lib/format';
import { useSidecarStore } from '@/store/sidecar';

const MB = 1024 * 1024;

/** Device, model, queue, watermark and the CPU-mode notice (D7: never silent). */
export function StatusBar() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const system = useSidecarStore((s) => s.system);
  const engine = useSidecarStore((s) => s.engine);
  const model = useSidecarStore((s) => s.capabilities);
  const preferences = useSidecarStore((s) => s.preferences);
  const unreachable = useSidecarStore((s) => s.unreachable);

  const device = system?.device;
  const items: { key: string; text: string; tone?: 'warn' | 'error' }[] = [];
  if (unreachable) {
    items.push({ key: 'unreachable', text: t('shell.status.disconnected'), tone: 'error' });
  }
  if (engine) {
    const name = model?.display_name ?? engine.model_id ?? '';
    items.push({
      key: 'engine',
      text: `${name} · ${t(`shell.status.engine.${engine.state}`)}`,
      tone: engine.state === 'error' ? 'error' : undefined,
    });
  }
  if (device) {
    const precision = engine?.runtime?.model_precision ?? device.precision;
    items.push({
      key: 'device',
      text: [device.name, t(`setup.environment.modes.${device.kind}`), precision]
        .filter(Boolean)
        .join(' · '),
    });
    if (device.memory_total_mb != null && device.memory_used_mb != null) {
      items.push({
        key: 'memory',
        text: t('shell.status.memory', {
          used: formatMemory(device.memory_used_mb * MB, locale),
          total: formatMemory(device.memory_total_mb * MB, locale),
        }),
      });
    }
  }
  if (system) {
    items.push({
      key: 'queue',
      text:
        system.queue_length > 0
          ? t('shell.status.queueCount', { count: system.queue_length })
          : t('shell.status.queueIdle'),
    });
  }
  if (preferences) {
    items.push({
      key: 'watermark',
      text: preferences.watermark_enabled
        ? t('shell.status.watermarkOn')
        : t('shell.status.watermarkOff'),
    });
  }
  for (const issue of system?.issues ?? []) {
    items.push({ key: issue, text: t(`errors.codes.${issue}`), tone: 'warn' });
  }
  if (device?.kind === 'cpu') {
    items.push({ key: 'cpu', text: t('shell.status.cpuMode'), tone: 'warn' });
  }

  return (
    <footer className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-200 bg-white px-4 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {items.map((item) => (
        <span
          key={item.key}
          className={
            item.tone === 'error'
              ? 'text-red-600 dark:text-red-400'
              : item.tone === 'warn'
                ? 'text-amber-700 dark:text-amber-300'
                : undefined
          }
        >
          {item.text}
        </span>
      ))}
    </footer>
  );
}
