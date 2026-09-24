'use client';

import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { ParamField } from '@/features/params/ParamField';
import {
  currentValue,
  isVisible,
  type ParamName,
  requestParams,
} from '@/features/params/schema';
import { GenerateBar } from '@/features/quick/GenerateBar';
import { STYLE_PRESETS } from '@/features/quick/stylePresets';
import { formatSeconds } from '@/lib/format';
import { codeOf, isBusy } from '@/lib/jobs';
import type { ModelCapabilities } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { applySaved, cancelJob, startDesign } from './jobs';
import { card, input, primaryButton, textarea } from './ui';

/** (a) Design a voice by caption: generate candidates, pick the one that sounds right,
 * save it — usually with that candidate as the voice's reference clip. */
export function NewDesignVoice({ model }: { model: ModelCapabilities }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const captionId = useId();
  const textId = useId();
  const nameId = useId();
  const api = useSidecarStore((s) => s.api);
  const design = useVoicesStore((s) => s.design);
  const update = useVoicesStore((s) => s.updateDesign);
  const setParam = useVoicesStore((s) => s.setDesignParam);
  const setInvalid = useVoicesStore((s) => s.setDesignInvalid);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onValidity = useCallback(
    (name: ParamName, valid: boolean) => setInvalid(name, !valid),
    [setInvalid],
  );

  if (!api) return null;

  const job = design.job;
  const busy = isBusy(job);
  const result = job?.phase === 'completed' ? job.result : null;
  const simple = model.params.filter(
    (param) => param.tier === 'simple' && isVisible(param, model.params, design.values, 'none'),
  );

  let problem: string | null = null;
  if (!design.caption.trim()) problem = t('voiceStudio.design.problems.needCaption');
  else if (!design.text.trim()) problem = t('voiceStudio.design.problems.needText');
  else if (Object.keys(design.invalid).length > 0) problem = t('quick.generate.invalidParams');

  const generate = () => {
    if (busy || problem) return;
    setError(null);
    void startDesign({
      text: design.text,
      caption: design.caption.trim(),
      reference: { kind: 'none' },
      params: requestParams(model.params, design.values),
    });
  };

  // A model without reference input can only keep the caption.
  const keepAudio = design.keepAudio && model.capabilities.speaker_reference;
  let saveProblem: string | null = null;
  if (!design.name.trim()) saveProblem = t('voiceStudio.new.problems.needName');
  else if (keepAudio && !design.chosenAudioId) {
    saveProblem = t('voiceStudio.design.problems.needChoice');
  }

  const save = async () => {
    if (saveProblem) return;
    setSaving(true);
    setError(null);
    try {
      const caption = design.caption.trim();
      const saved = await api.createVoice({
        name: design.name.trim(),
        source: 'designed',
        from_audio_id: keepAudio ? design.chosenAudioId : null,
        design_caption: caption,
        // Without a reference clip the caption is what makes the voice.
        caption_default: keepAudio ? null : caption,
        test_text: design.text.trim() || null,
      });
      const store = useVoicesStore.getState();
      store.resetDesign(t('quick.sampleText'));
      applySaved(saved);
      store.open({ kind: 'voice', voiceId: saved.voice.id });
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{t('voiceStudio.new.titles.designed')}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {t('voiceStudio.new.intros.designed')}
        </p>
      </div>

      <div className={`${card} space-y-4`}>
        <section className="space-y-2">
          <label htmlFor={captionId} className="text-sm font-medium">
            {t('voiceStudio.design.caption')}
          </label>
          <textarea
            id={captionId}
            lang="ja"
            rows={3}
            maxLength={model.limits.max_caption_chars}
            value={design.caption}
            placeholder={t('voiceStudio.design.captionPlaceholder')}
            onChange={(event) => update({ caption: event.target.value })}
            className={textarea}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-zinc-500">{t('quick.caption.presets')}</span>
            {STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.caption}
                onClick={() =>
                  update({
                    caption: design.caption.trim()
                      ? `${design.caption.trim()}${preset.caption}`
                      : preset.caption,
                  })
                }
                className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {t(`quick.stylePresets.${preset.id}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-500">{t('voiceStudio.design.captionHint')}</p>
        </section>

        <section className="space-y-2">
          <label htmlFor={textId} className="text-sm font-medium">
            {t('voiceStudio.design.text')}
          </label>
          <textarea
            id={textId}
            lang="ja"
            rows={2}
            maxLength={model.limits.max_text_chars}
            value={design.text}
            onChange={(event) => update({ text: event.target.value })}
            className={textarea}
          />
        </section>

        {simple.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {simple.map((param) => (
              <ParamField
                key={param.name}
                param={param}
                value={currentValue(param, design.values)}
                onChange={(value) => setParam(param.name, value, param.default)}
                onValidity={onValidity}
              />
            ))}
          </div>
        ) : null}
      </div>

      <GenerateBar
        job={job}
        problem={busy ? null : problem}
        onGenerate={generate}
        onCancel={() => void cancelJob(job?.id)}
        label={t('voiceStudio.design.generate')}
      />

      {result ? (
        <div className={`${card} space-y-4`}>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('voiceStudio.design.candidates')}</p>
            <p className="text-xs text-zinc-500">{t('voiceStudio.design.candidatesHint')}</p>
          </div>
          <ul role="radiogroup" aria-label={t('voiceStudio.design.candidates')} className="grid gap-3 sm:grid-cols-2">
            {result.outputs.map((output) => {
              const chosen = design.chosenAudioId === output.audio_id;
              return (
                <li
                  key={output.audio_id}
                  className={`space-y-2 rounded-lg border p-3 ${
                    chosen ? 'border-sky-500 ring-1 ring-sky-500' : 'border-zinc-200 dark:border-zinc-800'
                  }`}
                >
                  <label className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="design-candidate"
                        checked={chosen}
                        onChange={() => update({ chosenAudioId: output.audio_id })}
                      />
                      {t('quick.candidates.item', { index: output.index + 1 })}
                    </span>
                    <span className="text-xs text-zinc-500 tabular-nums">
                      {t('quick.candidates.duration', {
                        seconds: formatSeconds(output.duration_s, locale, 2),
                      })}
                    </span>
                  </label>
                  {/* Generated speech has no caption track. */}
                  <audio controls preload="metadata" src={api.audioUrl(output.audio_id)} className="w-full" />
                </li>
              );
            })}
          </ul>

          <div className="space-y-1.5">
            <label htmlFor={nameId} className="text-sm font-medium">
              {t('voiceStudio.fields.name')}
            </label>
            <input
              id={nameId}
              value={design.name}
              maxLength={100}
              placeholder={t('voiceStudio.fields.namePlaceholder')}
              onChange={(event) => update({ name: event.target.value })}
              className={input}
            />
          </div>
          {model.capabilities.speaker_reference ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={design.keepAudio}
                onChange={(event) => update({ keepAudio: event.target.checked })}
                className="mt-1"
              />
              <span>
                {t('voiceStudio.design.keepAudio')}
                <span className="block text-xs text-zinc-500">
                  {design.keepAudio
                    ? t('voiceStudio.design.keepAudioHint')
                    : t('voiceStudio.design.captionOnlyHint')}
                </span>
              </span>
            </label>
          ) : null}
          {error ? <ErrorNotice error={{ code: error }} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={saving || saveProblem !== null}
              onClick={() => void save()}
              className={primaryButton}
            >
              {t('voiceStudio.new.save')}
            </button>
            {saveProblem ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">{saveProblem}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
