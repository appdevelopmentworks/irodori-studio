'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { CrossIcon, WarningIcon } from '@/components/icons';
import { card, iconButton, input } from '@/components/ui';
import type { ScriptSpeaker, Voice } from '@/lib/types';
import { useScriptStore } from '@/store/script';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { edit } from './actions';

/** The speaker → voice map: each speaker's library voice (its reference and defaults) and
 * a caption for all of the speaker's lines. Changes are saved right away. */
export function SpeakersSection() {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const script = useScriptStore((s) => s.script);
  const voices = useVoicesStore((s) => s.voices);
  const [error, setError] = useState<string | null>(null);

  if (!api || !script) return null;

  const counts = new Map<string, number>();
  for (const line of script.lines) counts.set(line.speaker, (counts.get(line.speaker) ?? 0) + 1);
  const unvoiced = script.speakers.some((s) => !s.voice_id && (counts.get(s.name) ?? 0) > 0);

  const save = async (speakers: ScriptSpeaker[]) => {
    setError(await edit(() => api.updateScript(script.id, { speakers })));
  };
  const change = (name: string, patch: Partial<ScriptSpeaker>) =>
    save(script.speakers.map((s) => (s.name === name ? { ...s, ...patch } : s)));

  return (
    <section className={`${card} space-y-3`}>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t('script.speakers.title')}</h2>
        <p className="text-xs text-zinc-500">{t('script.speakers.hint')}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs whitespace-nowrap text-zinc-500">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('script.speakers.name')}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t('script.speakers.lines')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('script.speakers.voice')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('script.speakers.caption')}
              </th>
              <th scope="col" className="w-8 py-1">
                <span className="sr-only">{t('script.speakers.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {script.speakers.map((speaker) => (
              <SpeakerRow
                key={`${speaker.name}:${speaker.caption ?? ''}`}
                speaker={speaker}
                lines={counts.get(speaker.name) ?? 0}
                voices={voices ?? []}
                onChange={(patch) => void change(speaker.name, patch)}
                onRemove={() => void save(script.speakers.filter((s) => s.name !== speaker.name))}
              />
            ))}
          </tbody>
        </table>
      </div>
      {unvoiced ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <WarningIcon className="h-3.5 w-3.5" />
          {t('script.speakers.noVoiceWarning')}
        </p>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </section>
  );
}

function SpeakerRow({
  speaker,
  lines,
  voices,
  onChange,
  onRemove,
}: {
  speaker: ScriptSpeaker;
  lines: number;
  voices: Voice[];
  onChange: (patch: Partial<ScriptSpeaker>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [caption, setCaption] = useState(speaker.caption ?? '');
  const voice = voices.find((v) => v.id === speaker.voice_id) ?? null;
  const name = speaker.name || t('script.common.noSpeaker');

  return (
    <tr className="border-t border-zinc-100 align-top dark:border-zinc-800">
      <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">
        {name}
      </th>
      <td className="py-2 pr-3 text-right text-zinc-500 tabular-nums">{lines}</td>
      <td className="py-2 pr-3">
        <select
          value={speaker.voice_id ?? ''}
          aria-label={t('script.speakers.voiceFor', { name })}
          onChange={(event) => onChange({ voice_id: event.target.value || null })}
          className={`${input} min-w-72`}
        >
          <option value="">{t('script.speakers.voiceNone')}</option>
          {speaker.voice_id && !voice ? (
            <option value={speaker.voice_id} disabled>
              {t('script.speakers.voiceMissing')}
            </option>
          ) : null}
          {voices.map((v) => (
            <option key={v.id} value={v.id} disabled={v.consent_required && v.consent === null}>
              {t('script.speakers.voiceOption', {
                name: v.name,
                source: t(`voiceStudio.sources.${v.source}`),
              })}
            </option>
          ))}
        </select>
      </td>
      <td className="w-full py-2 pr-3">
        <input
          lang="ja"
          value={caption}
          maxLength={1000}
          aria-label={t('script.speakers.captionFor', { name })}
          placeholder={voice?.caption_default ?? t('script.speakers.captionPlaceholder')}
          onChange={(event) => setCaption(event.target.value)}
          onBlur={() => {
            const next = caption.trim() || null;
            if (next !== speaker.caption) onChange({ caption: next });
          }}
          className={input}
        />
      </td>
      <td className="py-2">
        {lines === 0 ? (
          <button
            type="button"
            title={t('script.speakers.remove')}
            aria-label={t('script.speakers.removeFor', { name })}
            onClick={onRemove}
            className={iconButton}
          >
            <CrossIcon className="h-4 w-4" />
          </button>
        ) : null}
      </td>
    </tr>
  );
}
