'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { button, card, input } from '@/components/ui';
import { DictionaryEditor } from '@/features/dictionary/DictionaryEditor';
import { ParamField } from '@/features/params/ParamField';
import { ParamPanel } from '@/features/params/ParamPanel';
import { currentValue, isVisible, type ParamName } from '@/features/params/schema';
import { codeOf } from '@/lib/jobs';
import type { ModelCapabilities } from '@/lib/types';
import { useScriptStore } from '@/store/script';
import { useSidecarStore } from '@/store/sidecar';

import { edit, loadRecent, saveSettings } from './actions';

const TOKENS = ['index', 'n', 'speaker', 'text_head', 'title', 'id'] as const;
const PREVIEW_NAMES = 3;

/** How every line is generated and exported: title, default pause, file naming template,
 * subtitles, parameters over each voice's defaults, and the user dictionary. */
export function SettingsSection({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const titleId = useId();
  const pauseId = useId();
  const templateId = useId();
  const templateField = useRef<HTMLInputElement>(null);
  const api = useSidecarStore((s) => s.api);
  const script = useScriptStore((s) => s.script);
  const draft = useScriptStore((s) => s.draft);
  const dirty = useScriptStore((s) => s.settingsDirty);
  const fileNames = useScriptStore((s) => s.fileNames);
  const fileNamesError = useScriptStore((s) => s.fileNamesError);
  const updateDraft = useScriptStore((s) => s.updateDraft);
  const setParam = useScriptStore((s) => s.setParam);
  const setInvalid = useScriptStore((s) => s.setInvalid);
  const [title, setTitle] = useState(script?.title ?? '');
  const [seenTitle, setSeenTitle] = useState(script?.title ?? '');
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onValidity = useCallback(
    (name: ParamName, valid: boolean) => setInvalid(name, !valid),
    [setInvalid],
  );

  if (!api || !script) return null;
  if (seenTitle !== script.title) {
    // A newer title from the sidecar (another script opened, or saved).
    setSeenTitle(script.title);
    setTitle(script.title);
  }

  // Speakers may have reference audio: show what applies to a voice.
  const simple = model.params.filter(
    (param) => param.tier === 'simple' && isVisible(param, model.params, draft.values, 'voice'),
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

  const saveTitle = async () => {
    const next = title.trim();
    if (!next) {
      setTitle(script.title);
      return;
    }
    if (next === script.title) return;
    setError(await edit(() => api.updateScript(script.id, { title: next })));
    void loadRecent();
  };

  const insertToken = (token: string) => {
    const field = templateField.current;
    const text = draft.namingTemplate;
    const focused = field !== null && document.activeElement === field;
    const start = focused ? (field.selectionStart ?? text.length) : text.length;
    const end = focused ? (field.selectionEnd ?? text.length) : text.length;
    const inserted = `{${token}}`;
    updateDraft({ namingTemplate: text.slice(0, start) + inserted + text.slice(end) });
    const caret = start + inserted.length;
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  };

  const ms = (value: string, fallback: number) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 10_000) : fallback;
  };

  return (
    <section className={`${card} space-y-5`}>
      <h2 className="text-sm font-semibold">{t('script.settings.title')}</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor={titleId} className="space-y-1 text-sm">
          <span className="block font-medium">{t('script.settings.scriptTitle')}</span>
          <input
            id={titleId}
            lang="ja"
            value={title}
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveTitle()}
            className={input}
          />
          <span className="block text-xs text-zinc-500">{t('script.settings.scriptTitleHint')}</span>
        </label>
        <label htmlFor={pauseId} className="space-y-1 text-sm">
          <span className="block font-medium">{t('script.settings.pause')}</span>
          <input
            id={pauseId}
            type="number"
            min={0}
            max={10000}
            step={50}
            value={draft.pauseMs}
            onChange={(event) => updateDraft({ pauseMs: ms(event.target.value, draft.pauseMs) })}
            className={input}
          />
          <span className="block text-xs text-zinc-500">{t('script.settings.pauseHint')}</span>
        </label>
      </div>

      <div className="space-y-2">
        <label htmlFor={templateId} className="text-sm font-medium">
          {t('script.settings.template')}
        </label>
        <input
          id={templateId}
          ref={templateField}
          value={draft.namingTemplate}
          maxLength={200}
          spellCheck={false}
          onChange={(event) => updateDraft({ namingTemplate: event.target.value })}
          className={`${input} font-mono`}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-zinc-500">{t('script.settings.templateHint')}</span>
          {TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              title={t(`script.settings.tokens.${token}`)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertToken(token)}
              className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <span className="font-mono">{`{${token}}`}</span>{' '}
              <span className="text-zinc-500">{t(`script.settings.tokens.${token}`)}</span>
            </button>
          ))}
        </div>
        {fileNamesError ? (
          <p className="text-xs text-red-700 dark:text-red-300">
            {fileNamesError === 'naming_template_invalid'
              ? t('errors.codes.naming_template_invalid')
              : t('errors.codes.internal')}
          </p>
        ) : fileNames && fileNames.length > 0 ? (
          <p className="text-xs break-all text-zinc-500">
            {t('script.settings.preview', {
              names: fileNames
                .slice(0, PREVIEW_NAMES)
                .map((name) => `${name}.wav`)
                .join(t('script.settings.previewSeparator')),
            })}
            {fileNames.length > PREVIEW_NAMES
              ? ` ${t('script.settings.previewMore', { count: fileNames.length - PREVIEW_NAMES })}`
              : null}
          </p>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.subtitleSpeakers}
          onChange={(event) => updateDraft({ subtitleSpeakers: event.target.checked })}
        />
        {t('script.settings.subtitleSpeakers')}
      </label>

      <div className="space-y-3">
        <p className="text-xs text-zinc-500">{t('script.settings.paramsHint')}</p>
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
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm font-medium select-none">
            {t('script.settings.advanced')}
          </summary>
          <div className="pt-2">
            <ParamPanel
              schema={model.params}
              values={draft.values}
              reference="voice"
              onChange={(param, value) => setParam(param.name, value, param.default)}
              onValidity={onValidity}
              runtime={false}
            />
          </div>
        </details>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.applyDictionary}
              onChange={(event) => updateDraft({ applyDictionary: event.target.checked })}
            />
            {t('script.settings.dictionary')}
          </label>
          <button
            type="button"
            aria-expanded={dictionaryOpen}
            onClick={() => setDictionaryOpen((open) => !open)}
            className={button}
          >
            {dictionaryOpen
              ? t('script.settings.closeDictionary')
              : t('script.settings.editDictionary')}
          </button>
        </div>
        {dictionaryOpen ? (
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <DictionaryEditor />
          </div>
        ) : null}
      </div>

      {error ? <ErrorNotice error={{ code: error }} /> : null}
      {dirty ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={saving || fileNamesError !== null}
            onClick={() => void save()}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {t('script.settings.save')}
          </button>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t('script.settings.unsaved')}
          </p>
        </div>
      ) : null}
    </section>
  );
}
