'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { button, card, input, link, textarea } from '@/components/ui';
import { DictionaryEditor } from '@/features/dictionary/DictionaryEditor';
import { ParamField } from '@/features/params/ParamField';
import { ParamPanel } from '@/features/params/ParamPanel';
import { PresetBar } from '@/features/params/PresetBar';
import { currentValue, isVisible, type ParamName } from '@/features/params/schema';
import { STYLE_PRESETS } from '@/features/quick/stylePresets';
import { codeOf } from '@/lib/jobs';
import type { ModelCapabilities } from '@/lib/types';
import { useNarrationStore } from '@/store/narration';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { draftWithVoice, saveSettings } from './actions';

/** How every chunk is generated: the voice (with its defaults), voice lock, caption,
 * parameters, pauses and the user dictionary. */
export function SettingsSection({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const voiceId = useId();
  const captionId = useId();
  const sentenceId = useId();
  const paragraphId = useId();
  const api = useSidecarStore((s) => s.api);
  const voices = useVoicesStore((s) => s.voices);
  const draft = useNarrationStore((s) => s.draft);
  const dirty = useNarrationStore((s) => s.settingsDirty);
  const updateDraft = useNarrationStore((s) => s.updateDraft);
  const setParam = useNarrationStore((s) => s.setParam);
  const setInvalid = useNarrationStore((s) => s.setInvalid);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (api) void useVoicesStore.getState().load();
  }, [api]);

  const onValidity = useCallback(
    (name: ParamName, valid: boolean) => setInvalid(name, !valid),
    [setInvalid],
  );

  const voice = voices?.find((v) => v.id === draft.voiceId) ?? null;
  const speakerAudio = voice !== null && (voice.clips.length > 0 || voice.embedding !== null);
  const reference = voice ? 'voice' : 'none';
  const simple = model.params.filter(
    (param) => param.tier === 'simple' && isVisible(param, model.params, draft.values, reference),
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings(model.params);
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setSaving(false);
    }
  };

  const ms = (value: string, fallback: number) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 10_000) : fallback;
  };

  return (
    <section className={`${card} space-y-5`}>
      <h2 className="text-sm font-semibold">{t('narration.settings.title')}</h2>

      <div className="space-y-2">
        <label htmlFor={voiceId} className="text-sm font-medium">
          {t('narration.settings.voice')}
        </label>
        <select
          id={voiceId}
          value={draft.voiceId ?? ''}
          onChange={(event) => {
            const next = voices?.find((v) => v.id === event.target.value) ?? null;
            const state = useNarrationStore.getState();
            state.updateDraft(draftWithVoice(state.draft, next, model.params));
          }}
          className={input}
        >
          <option value="">{t('narration.settings.voiceNone')}</option>
          {(voices ?? []).map((v) => (
            <option key={v.id} value={v.id} disabled={v.consent_required && v.consent === null}>
              {t('narration.settings.voiceOption', {
                name: v.name,
                source: t(`voiceStudio.sources.${v.source}`),
              })}
            </option>
          ))}
        </select>
        {speakerAudio ? (
          <p className="text-xs text-zinc-500">{t('narration.settings.voiceHintReference')}</p>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('narration.settings.voiceHintNone')}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.voiceLock}
                onChange={(event) => updateDraft({ voiceLock: event.target.checked })}
                className="mt-1"
              />
              <span>
                {t('narration.settings.voiceLock')}
                <span className="block text-xs text-zinc-500">
                  {t('narration.settings.voiceLockHint')}
                </span>
              </span>
            </label>
          </div>
        )}
      </div>

      {model.capabilities.caption ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={captionId} className="text-sm font-medium">
              {t('narration.settings.caption')}
            </label>
            {draft.caption ? (
              <button type="button" onClick={() => updateDraft({ caption: '' })} className={link}>
                {t('quick.caption.clear')}
              </button>
            ) : null}
          </div>
          <textarea
            id={captionId}
            lang="ja"
            rows={2}
            maxLength={model.limits.max_caption_chars}
            value={draft.caption}
            placeholder={t('quick.caption.placeholder')}
            onChange={(event) => updateDraft({ caption: event.target.value })}
            className={textarea}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-zinc-500">{t('quick.caption.presets')}</span>
            {STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.caption}
                aria-pressed={draft.caption === preset.caption}
                onClick={() => updateDraft({ caption: preset.caption })}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  draft.caption === preset.caption
                    ? 'border-sky-600 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                    : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
                }`}
              >
                {t(`quick.stylePresets.${preset.id}`)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {simple.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {simple.map((param) => (
            <ParamField
              key={param.name}
              param={param}
              value={currentValue(param, draft.values)}
              onChange={(value) => setParam(param.name, value, param.default)}
              onValidity={onValidity}
            />
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor={sentenceId} className="space-y-1 text-sm">
          <span className="block font-medium">{t('narration.settings.sentencePause')}</span>
          <input
            id={sentenceId}
            type="number"
            min={0}
            max={5000}
            step={50}
            value={draft.pauses.sentence_ms}
            onChange={(event) =>
              updateDraft({
                pauses: {
                  ...draft.pauses,
                  sentence_ms: ms(event.target.value, draft.pauses.sentence_ms),
                },
              })
            }
            className={input}
          />
        </label>
        <label htmlFor={paragraphId} className="space-y-1 text-sm">
          <span className="block font-medium">{t('narration.settings.paragraphPause')}</span>
          <input
            id={paragraphId}
            type="number"
            min={0}
            max={10000}
            step={50}
            value={draft.pauses.paragraph_ms}
            onChange={(event) =>
              updateDraft({
                pauses: {
                  ...draft.pauses,
                  paragraph_ms: ms(event.target.value, draft.pauses.paragraph_ms),
                },
              })
            }
            className={input}
          />
        </label>
      </div>
      <p className="text-xs text-zinc-500">{t('narration.settings.pausesHint')}</p>

      <details className="space-y-2">
        <summary className="cursor-pointer text-sm font-medium select-none">
          {t('narration.settings.advanced')}
        </summary>
        <div className="space-y-3 pt-2">
          <PresetBar
            schema={model.params}
            values={draft.values}
            onLoad={(values) => updateDraft({ values })}
          />
          <ParamPanel
            schema={model.params}
            values={draft.values}
            reference={reference}
            onChange={(param, value) => setParam(param.name, value, param.default)}
            onValidity={onValidity}
            runtime={false}
          />
        </div>
      </details>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.applyDictionary}
              onChange={(event) => updateDraft({ applyDictionary: event.target.checked })}
            />
            {t('narration.settings.dictionary')}
          </label>
          <button
            type="button"
            aria-expanded={dictionaryOpen}
            onClick={() => setDictionaryOpen((open) => !open)}
            className={button}
          >
            {dictionaryOpen
              ? t('narration.settings.closeDictionary')
              : t('narration.settings.editDictionary')}
          </button>
        </div>
        {dictionaryOpen ? (
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <DictionaryEditor onSaved={() => useNarrationStore.getState().clearReadings()} />
          </div>
        ) : null}
      </div>

      {error ? <ErrorNotice error={{ code: error }} /> : null}
      {dirty ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {t('narration.settings.save')}
          </button>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t('narration.settings.unsaved')}
          </p>
        </div>
      ) : null}
    </section>
  );
}
