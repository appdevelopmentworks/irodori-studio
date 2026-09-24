'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CandidateGrid } from '@/components/CandidateGrid';
import { ErrorNotice } from '@/components/ErrorNotice';
import { ChevronIcon, Spinner } from '@/components/icons';
import { ParamField } from '@/features/params/ParamField';
import { ParamPanel } from '@/features/params/ParamPanel';
import { currentValue, isVisible, type ParamName } from '@/features/params/schema';
import { ApiError } from '@/lib/api';
import { isBusy } from '@/lib/jobs';
import { pickSavePath } from '@/lib/tauri';
import type { AudioFormat, AudioOutput } from '@/lib/types';
import { useQuickStore } from '@/store/quick';
import { useSidecarStore } from '@/store/sidecar';

import { CaptionSection } from './CaptionSection';
import { GenerateBar } from './GenerateBar';
import { cancelGeneration, startGeneration } from './generation';
import { LoraField } from './LoraField';
import { buildRequest, requestProblem } from './request';
import { RunLog } from './RunLog';
import { TextSection } from './TextSection';
import { VoiceSection } from './VoiceSection';

const card =
  'rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900';

const SAVE_FORMATS: AudioFormat[] = ['wav', 'mp3', 'm4a', 'flac', 'opus'];

/** かんたん生成: text → voice → emotion → generate → listen → save on one screen
 * (requirements §6.4), with every Space parameter one click away. */
export function QuickScreen() {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const model = useSidecarStore((s) => s.capabilities);
  const loadError = useSidecarStore((s) => s.loadError);
  const ffmpeg = useSidecarStore((s) => s.system?.ffmpeg_available ?? false);
  const values = useQuickStore((s) => s.values);
  const reference = useQuickStore((s) => s.reference);
  const job = useQuickStore((s) => s.job);
  const saved = useQuickStore((s) => s.saved);
  const problem = useQuickStore(requestProblem);
  const setParam = useQuickStore((s) => s.setParam);
  const setInvalid = useQuickStore((s) => s.setInvalid);
  const resetParams = useQuickStore((s) => s.resetParams);
  const consumeAutoplay = useQuickStore((s) => s.consumeAutoplay);
  const saveFormat = useQuickStore((s) => s.saveFormat);
  const setSaveFormat = useQuickStore((s) => s.setSaveFormat);
  const [actionError, setActionError] = useState<string | null>(null);

  // Play a fresh result once, not again whenever the screen is revisited.
  const autoplay = job?.autoplay ?? false;
  useEffect(() => {
    if (autoplay) consumeAutoplay();
  }, [autoplay, consumeAutoplay]);

  const onValidity = useCallback(
    (name: ParamName, valid: boolean) => setInvalid(name, !valid),
    [setInvalid],
  );

  if (loadError) {
    return (
      <div className="p-6">
        <ErrorNotice error={{ code: loadError }} />
      </div>
    );
  }
  if (!model || !api) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const busy = isBusy(job);
  const generate = () => {
    const state = useQuickStore.getState();
    if (isBusy(state.job) || requestProblem(state)) return;
    setActionError(null);
    void startGeneration(buildRequest(state, model));
  };

  const simple = model.params.filter(
    (param) => param.tier === 'simple' && isVisible(param, model.params, values, reference),
  );
  const changed = Object.keys(values).length;
  const result = job?.phase === 'completed' ? job.result : null;

  const adopt = async (audioId: string | null) => {
    if (!result) return;
    try {
      const entry = await api.updateHistoryEntry(result.history_id, { adopted_audio_id: audioId });
      useQuickStore.getState().setAdopted(entry.adopted_audio_id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.code : 'internal');
    }
  };

  // Formats other than WAV are encoded by ffmpeg (D20).
  const format: AudioFormat = ffmpeg ? saveFormat : 'wav';
  const save = async (output: AudioOutput) => {
    const stamp = new Date(job?.finishedAt ?? Date.now())
      .toISOString()
      .slice(0, 19)
      .replace(/[-:]/g, '')
      .replace('T', '-');
    const path = await pickSavePath(
      t('quick.candidates.saveTitle'),
      `irodori_${stamp}_${output.index + 1}.${format}`,
      [{ name: t(`quick.candidates.formats.${format}`), extensions: [format] }],
    );
    if (!path) return;
    try {
      const file = await api.saveAudio(output.audio_id, path, format);
      useQuickStore.getState().markSaved(output.audio_id, file.path);
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.code : 'internal');
    }
  };

  return (
    <div className="mx-auto grid max-w-7xl gap-6 p-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-5">
        <h1 className="text-xl font-semibold tracking-tight">{t('quick.title')}</h1>
        <div className={`${card} space-y-5`}>
          <TextSection maxChars={model.limits.max_text_chars} onSubmit={generate} />
          <VoiceSection model={model} />
          {model.capabilities.caption ? (
            <CaptionSection maxChars={model.limits.max_caption_chars} />
          ) : null}
        </div>

        {simple.length > 0 ? (
          <div className={`${card} space-y-3`}>
            <p className="text-sm font-medium">{t('quick.simple.title')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {simple.map((param) => (
                <ParamField
                  key={param.name}
                  param={param}
                  value={currentValue(param, values)}
                  onChange={(value) => setParam(param.name, value, param.default)}
                  onValidity={onValidity}
                />
              ))}
            </div>
          </div>
        ) : null}

        <GenerateBar
          job={job}
          problem={busy || !problem ? null : t(`quick.generate.${problem}`)}
          onGenerate={generate}
          onCancel={() => void cancelGeneration()}
        />

        <details className="group space-y-2">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
            <ChevronIcon className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-90" />
            <span>{t('quick.advanced.title')}</span>
            {changed > 0 ? (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                {t('quick.advanced.changed', { count: changed })}
              </span>
            ) : null}
          </summary>
          <div className="space-y-2 pt-2">
            {changed > 0 ? (
              <button
                type="button"
                onClick={resetParams}
                className="text-xs text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
              >
                {t('quick.advanced.reset')}
              </button>
            ) : null}
            <ParamPanel
              schema={model.params}
              values={values}
              reference={reference}
              onChange={(param, value) => setParam(param.name, value, param.default)}
              onValidity={onValidity}
              extras={{ advanced: model.capabilities.lora ? <LoraField /> : null }}
            />
          </div>
        </details>
      </div>

      <div className="min-w-0 space-y-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-5rem)] lg:self-start lg:overflow-y-auto lg:pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{t('quick.candidates.title')}</h2>
          {result ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">{t('quick.candidates.format')}</span>
              <select
                value={format}
                onChange={(event) => setSaveFormat(event.target.value as AudioFormat)}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {SAVE_FORMATS.map((option) => (
                  <option key={option} value={option} disabled={option !== 'wav' && !ffmpeg}>
                    {t(`quick.candidates.formats.${option}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {result && !ffmpeg ? (
          <p className="text-xs text-zinc-500">{t('quick.candidates.needFfmpeg')}</p>
        ) : null}
        {actionError ? <ErrorNotice error={{ code: actionError }} /> : null}
        {result ? (
          <CandidateGrid
            outputs={result.outputs}
            audioUrl={api.audioUrl}
            adoptedId={job?.adoptedAudioId ?? null}
            onAdopt={(audioId) => void adopt(audioId)}
            onSave={(output) => void save(output)}
            saved={saved}
            autoPlayFirst={autoplay}
          />
        ) : (
          <p className="text-sm text-zinc-500">{t('quick.candidates.empty')}</p>
        )}
        <RunLog seedParam={model.params.find((param) => param.name === 'seed')} />
      </div>
    </div>
  );
}
