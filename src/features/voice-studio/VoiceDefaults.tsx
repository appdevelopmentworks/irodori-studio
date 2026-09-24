'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { ParamField } from '@/features/params/ParamField';
import { ParamPanel } from '@/features/params/ParamPanel';
import {
  currentValue,
  isVisible,
  type ParamName,
  type ParamValues,
  requestParams,
} from '@/features/params/schema';
import { GenerateBar } from '@/features/quick/GenerateBar';
import { STYLE_PRESETS } from '@/features/quick/stylePresets';
import { formatSeconds } from '@/lib/format';
import { codeOf } from '@/lib/jobs';
import { pickDirectory } from '@/lib/tauri';
import type {
  ModelCapabilities,
  ParamSchema,
  SynthesisRequest,
  Voice,
  VoicePatch,
} from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { applySaved, cancelJob, startAudition } from './jobs';
import { button, card, input, link, primaryButton, textarea } from './ui';

/** A voice's defaults as parameter values: `params_default` plus `seed_default` (the
 * schema's seed). Values equal to the schema default are left out, as in the Quick form. */
export function voiceValues(voice: Voice, schema: ParamSchema[]): ParamValues {
  const values: ParamValues = {};
  for (const param of schema) {
    const value = param.name === 'seed' ? voice.seed_default : voice.params_default[param.name];
    if (value !== undefined && value !== param.default) values[param.name] = value;
  }
  return values;
}

const sameValues = (a: ParamValues, b: ParamValues) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ParamName>;
  return [...keys].every((key) => a[key] === b[key]);
};

/** The defaults a voice brings to a generation (caption, parameters, seed, LoRA) and a
 * test phrase to audition them with — before saving. */
export function VoiceDefaults({ voice, model }: { voice: Voice; model: ModelCapabilities }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const nameId = useId();
  const captionId = useId();
  const textId = useId();
  const api = useSidecarStore((s) => s.api);
  const audition = useVoicesStore((s) => (s.audition?.voiceId === voice.id ? s.audition : null));
  const consumeAutoplay = useVoicesStore((s) => s.consumeAuditionAutoplay);
  const initial = voiceValues(voice, model.params);
  const [name, setName] = useState(voice.name);
  const [caption, setCaption] = useState(voice.caption_default ?? '');
  const [values, setValues] = useState<ParamValues>(initial);
  const [invalid, setInvalid] = useState<Partial<Record<ParamName, true>>>({});
  const [loraPath, setLoraPath] = useState(voice.lora_path);
  const [testText, setTestText] = useState(voice.test_text ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const firstOutput = useRef<HTMLAudioElement>(null);

  const onValidity = useCallback((param: ParamName, valid: boolean) => {
    setInvalid((current) => {
      if (Boolean(current[param]) === !valid) return current;
      const next = { ...current };
      if (valid) delete next[param];
      else next[param] = true;
      return next;
    });
  }, []);

  // Play a fresh audition once (not again when the screen is revisited).
  const autoplay = audition?.autoplay ?? false;
  useEffect(() => {
    if (!autoplay) return;
    firstOutput.current?.play().catch(() => undefined);
    consumeAutoplay();
  }, [autoplay, consumeAutoplay]);

  if (!api) return null;

  const setParam = (param: ParamSchema, value: ParamValues[ParamName]) =>
    setValues((current) => {
      const next = { ...current };
      if (value === param.default) delete next[param.name];
      else next[param.name] = value;
      return next;
    });

  const trimmedCaption = caption.trim();
  const dirty =
    name.trim() !== voice.name ||
    trimmedCaption !== (voice.caption_default ?? '') ||
    !sameValues(values, initial) ||
    loraPath !== voice.lora_path ||
    testText.trim() !== (voice.test_text ?? '');
  const hasInvalid = Object.keys(invalid).length > 0;

  const save = async () => {
    const patch: VoicePatch = {};
    if (name.trim() !== voice.name) patch.name = name.trim();
    if (trimmedCaption !== (voice.caption_default ?? '')) {
      patch.caption_default = trimmedCaption || null;
    }
    if (!sameValues(values, initial)) {
      const { seed, ...rest } = values;
      patch.params_default = requestParams(model.params, rest);
      patch.seed_default = typeof seed === 'number' ? seed : null;
    }
    if (loraPath !== voice.lora_path) patch.lora_path = loraPath;
    if (testText.trim() !== (voice.test_text ?? '')) patch.test_text = testText.trim() || null;
    setSaving(true);
    setError(null);
    try {
      applySaved(await api.updateVoice(voice.id, patch));
      setSavedAt(Date.now());
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    setName(voice.name);
    setCaption(voice.caption_default ?? '');
    setValues(initial);
    setInvalid({});
    setLoraPath(voice.lora_path);
    setTestText(voice.test_text ?? '');
  };

  const listen = () => {
    const request: SynthesisRequest = {
      text: testText.trim() || t('quick.sampleText'),
      reference: { kind: 'voice', voice_id: voice.id },
      params: requestParams(model.params, values),
    };
    if (trimmedCaption && model.capabilities.caption) request.caption = trimmedCaption;
    if (loraPath && model.capabilities.lora) request.lora_adapter = loraPath;
    void startAudition(voice.id, request);
  };

  const chooseLora = async () => {
    const path = await pickDirectory(t('quick.lora.chooseTitle'), loraPath ?? undefined);
    if (path) setLoraPath(path);
  };

  const simple = model.params.filter(
    (param) => param.tier === 'simple' && isVisible(param, model.params, values, 'voice'),
  );
  const job = audition?.job ?? null;
  const result = job?.phase === 'completed' ? job.result : null;

  return (
    <div className="space-y-5">
      <div className={`${card} space-y-4`}>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('voiceStudio.defaults.title')}</h3>
          <p className="text-xs text-zinc-500">{t('voiceStudio.defaults.hint')}</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t('voiceStudio.fields.name')}
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            className={input}
          />
        </div>

        {model.capabilities.caption ? (
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={captionId} className="text-sm font-medium">
                {t('voiceStudio.defaults.caption')}
              </label>
              {caption ? (
                <button type="button" onClick={() => setCaption('')} className={link}>
                  {t('quick.caption.clear')}
                </button>
              ) : null}
            </div>
            <textarea
              id={captionId}
              lang="ja"
              rows={2}
              maxLength={model.limits.max_caption_chars}
              value={caption}
              placeholder={t('quick.caption.placeholder')}
              onChange={(event) => setCaption(event.target.value)}
              className={textarea}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-zinc-500">{t('quick.caption.presets')}</span>
              {STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.caption}
                  aria-pressed={caption === preset.caption}
                  onClick={() => setCaption(preset.caption)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    caption === preset.caption
                      ? 'border-sky-600 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                      : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
                  }`}
                >
                  {t(`quick.stylePresets.${preset.id}`)}
                </button>
              ))}
            </div>
            {voice.clips.length > 0 || voice.embedding ? (
              <p className="text-xs text-zinc-500">{t('quick.caption.conflictHint')}</p>
            ) : null}
          </section>
        ) : null}

        {simple.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {simple.map((param) => (
              <ParamField
                key={param.name}
                param={param}
                value={currentValue(param, values)}
                onChange={(value) => setParam(param, value)}
                onValidity={onValidity}
              />
            ))}
          </div>
        ) : null}

        <details className="space-y-2">
          <summary className="cursor-pointer text-sm font-medium select-none">
            {t('voiceStudio.defaults.advanced')}
          </summary>
          <div className="pt-2">
            <ParamPanel
              schema={model.params}
              values={values}
              reference="voice"
              onChange={setParam}
              onValidity={onValidity}
              runtime={false}
              extras={{
                advanced: model.capabilities.lora ? (
                  <div className="space-y-1.5 md:col-span-2">
                    <p className="text-sm font-medium">{t('quick.lora.label')}</p>
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate rounded-md border border-zinc-300 px-2 py-1.5 font-mono text-xs dark:border-zinc-700">
                        {loraPath ?? t('quick.lora.none')}
                      </p>
                      <button type="button" onClick={() => void chooseLora()} className={button}>
                        {t('quick.lora.choose')}
                      </button>
                      {loraPath ? (
                        <button type="button" onClick={() => setLoraPath(null)} className={button}>
                          {t('quick.lora.clear')}
                        </button>
                      ) : null}
                    </div>
                    <p className="text-xs text-zinc-500">{t('voiceStudio.defaults.loraHint')}</p>
                  </div>
                ) : null,
              }}
            />
          </div>
        </details>

        <section className="space-y-2">
          <label htmlFor={textId} className="text-sm font-medium">
            {t('voiceStudio.defaults.testText')}
          </label>
          <textarea
            id={textId}
            lang="ja"
            rows={2}
            maxLength={model.limits.max_text_chars}
            value={testText}
            placeholder={t('quick.sampleText')}
            onChange={(event) => setTestText(event.target.value)}
            className={textarea}
          />
        </section>

        {error ? <ErrorNotice error={{ code: error }} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!dirty || saving || hasInvalid || !name.trim()}
            onClick={() => void save()}
            className={primaryButton}
          >
            {t('voiceStudio.defaults.save')}
          </button>
          {dirty ? (
            <button type="button" disabled={saving} onClick={revert} className={button}>
              {t('voiceStudio.defaults.revert')}
            </button>
          ) : null}
          {dirty ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('voiceStudio.defaults.unsaved')}
            </p>
          ) : savedAt ? (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">
              {t('voiceStudio.defaults.saved')}
            </p>
          ) : null}
        </div>
      </div>

      <div className={`${card} space-y-3`}>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('voiceStudio.audition.title')}</h3>
          <p className="text-xs text-zinc-500">{t('voiceStudio.audition.hint')}</p>
        </div>
        <GenerateBar
          job={job}
          problem={hasInvalid ? t('quick.generate.invalidParams') : null}
          onGenerate={listen}
          onCancel={() => void cancelJob(job?.id)}
          label={t('voiceStudio.audition.listen')}
        />
        {result ? (
          <ul className="space-y-2">
            {result.outputs.map((output) => (
              <li key={output.audio_id} className="space-y-1">
                <p className="flex justify-between text-xs text-zinc-500">
                  <span>{t('quick.candidates.item', { index: output.index + 1 })}</span>
                  <span className="tabular-nums">
                    {t('quick.candidates.duration', {
                      seconds: formatSeconds(output.duration_s, locale, 2),
                    })}
                  </span>
                </p>
                {/* Generated speech has no caption track. */}
                <audio
                  ref={output.index === 0 ? firstOutput : undefined}
                  controls
                  preload="metadata"
                  src={api.audioUrl(output.audio_id)}
                  className="w-full"
                />
              </li>
            ))}
          </ul>
        ) : null}
        {result?.timings.encode_reference !== undefined ? (
          <p className="text-xs text-zinc-500">{t('voiceStudio.audition.encoded')}</p>
        ) : null}
      </div>
    </div>
  );
}
