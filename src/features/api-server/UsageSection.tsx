'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CopyButton } from '@/components/CopyButton';
import { card, smallButton } from '@/components/ui';
import { STYLE_PRESETS, type StylePresetId } from '@/features/quick/stylePresets';
import type { ApiStyle } from '@/lib/types';
import { useApiServerStore } from '@/store/apiServer';

import { openaiExample } from './snippets';

type UsageTab = 'openai' | 'voicevox';

const TABS: UsageTab[] = ['openai', 'voicevox'];
const PRESET_IDS = new Set<string>(STYLE_PRESETS.map((preset) => preset.id));
const darkButton =
  'rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-100 hover:bg-zinc-700';

/** How other apps connect: the OpenAI SDK example, and the VOICEVOX engine URL with the
 * speakers and style ids the library offers. */
export function UsageSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<UsageTab>('openai');
  const config = useApiServerStore((s) => s.config);
  const status = useApiServerStore((s) => s.status);
  const styles = useApiServerStore((s) => s.styles);

  if (!config) return null;
  const baseUrl = status?.urls[0] ?? `http://127.0.0.1:${config.port}`;
  const keySet = config.api_key !== null;

  return (
    <section className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('apiServer.usage.title')}</h2>
        <div role="tablist" aria-label={t('apiServer.usage.title')} className="flex gap-1">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1 text-sm ${
                tab === id
                  ? 'bg-sky-50 font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              {t(`apiServer.usage.tabs.${id}`)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'openai' ? (
        <div className="space-y-3 text-sm">
          <p>{t('apiServer.usage.openaiIntro')}</p>
          <p className="text-zinc-600 dark:text-zinc-400">{t('apiServer.usage.openaiOptions')}</p>
          <p className="text-xs font-medium text-zinc-500">{t('apiServer.usage.example')}</p>
          <CodeBlock code={openaiExample(baseUrl, keySet, styles?.[0]?.voice_name ?? 'none')} />
          {keySet ? <p className="text-xs text-zinc-500">{t('apiServer.usage.exampleKey')}</p> : null}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>{t('apiServer.usage.voicevoxIntro')}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800">
              {baseUrl}
            </code>
            <CopyButton text={baseUrl} className={smallButton} />
          </div>
          <p>{t('apiServer.usage.voicevoxMapping')}</p>
          <p className="text-zinc-600 dark:text-zinc-400">{t('apiServer.usage.voicevoxLimits')}</p>
          {keySet ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('apiServer.usage.voicevoxKey')}
            </p>
          ) : null}
          {styles ? <StylesTable styles={styles} /> : null}
        </div>
      )}
    </section>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 pr-20 font-mono text-xs leading-relaxed text-zinc-100">
        <code>{code}</code>
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={code} className={darkButton} />
      </div>
    </div>
  );
}

/** One row per style, grouped by voice (the sidecar lists them that way). */
function StylesTable({ styles }: { styles: ApiStyle[] }) {
  const { t } = useTranslation();

  if (styles.length === 0) {
    return <p className="text-xs text-zinc-500">{t('apiServer.usage.stylesEmpty')}</p>;
  }
  const label = (style: ApiStyle) =>
    style.style === 'normal'
      ? t('apiServer.usage.normal')
      : PRESET_IDS.has(style.style)
        ? t(`quick.stylePresets.${style.style as StylePresetId}`)
        : style.name;
  const voices = new Set(styles.map((style) => style.voice_id)).size;

  return (
    <details>
      <summary className="cursor-pointer font-medium select-none">
        {t('apiServer.usage.styles', { count: voices })}
      </summary>
      <div className="mt-2 max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-white text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('apiServer.usage.voice')}</th>
              <th className="py-1 pr-3 font-medium">{t('apiServer.usage.style')}</th>
              <th className="py-1 text-right font-medium">{t('apiServer.usage.styleId')}</th>
            </tr>
          </thead>
          <tbody>
            {styles.map((style, index) => {
              const first = index === 0 || styles[index - 1].voice_id !== style.voice_id;
              const text = label(style);
              return (
                <tr
                  key={style.style_id}
                  className={first ? 'border-t border-zinc-200 dark:border-zinc-800' : undefined}
                >
                  <td className="py-1 pr-3 font-medium">{first ? style.voice_name : null}</td>
                  <td className="py-1 pr-3">
                    {text}
                    {text !== style.name ? (
                      <span className="ml-2 text-zinc-500">{style.name}</span>
                    ) : null}
                  </td>
                  <td className="py-1 text-right font-mono tabular-nums">{style.style_id}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
