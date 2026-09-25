'use client';

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CopyButton } from '@/components/CopyButton';
import { ErrorNotice } from '@/components/ErrorNotice';
import { button, card, input, primaryButton } from '@/components/ui';
import type { ApiServerConfig } from '@/lib/types';
import { useApiServerStore } from '@/store/apiServer';

import { generateApiKey, isValidApiKey, MAX_PORT, MIN_PORT } from './snippets';

const BINDS = [
  { id: 'local', label: 'apiServer.config.bindLocal', hint: 'apiServer.config.bindLocalHint' },
  { id: 'lan', label: 'apiServer.config.bindLan', hint: 'apiServer.config.bindLanHint' },
] as const;

const warning = 'text-xs text-amber-700 dark:text-amber-300';

/** Enable, bind, port and API key. Saving applies them at once: the listener starts,
 * restarts or stops. */
export function ConfigSection({ config }: { config: ApiServerConfig }) {
  const { t } = useTranslation();
  const bindName = useId();
  const portId = useId();
  const keyId = useId();
  const saved = useApiServerStore((s) => s.config) ?? config;
  const [enabled, setEnabled] = useState(config.enabled);
  const [bind, setBind] = useState<ApiServerConfig['bind']>(config.bind);
  const [port, setPort] = useState(String(config.port));
  const [apiKey, setApiKey] = useState(config.api_key ?? '');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const portNumber = Number(port);
  const portValid =
    port.trim() !== '' &&
    Number.isInteger(portNumber) &&
    portNumber >= MIN_PORT &&
    portNumber <= MAX_PORT;
  const key = apiKey.trim();
  const keyValid = key === '' || isValidApiKey(key);
  const keyMissing = bind === 'lan' && key === '';
  const valid = portValid && keyValid && !keyMissing;
  const draft: ApiServerConfig = {
    enabled,
    bind,
    port: portNumber,
    api_key: key === '' ? null : key,
  };
  const changed =
    draft.enabled !== saved.enabled ||
    draft.bind !== saved.bind ||
    draft.port !== saved.port ||
    draft.api_key !== saved.api_key;

  const save = async () => {
    setSaving(true);
    setError(null);
    const code = await useApiServerStore.getState().save(draft);
    setSaving(false);
    setError(code);
    setDone(code === null);
  };

  return (
    <section className={`${card} space-y-4`}>
      <h2 className="text-sm font-semibold">{t('apiServer.config.title')}</h2>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="h-4 w-4"
        />
        {t('apiServer.config.enabled')}
      </label>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs text-zinc-500">{t('apiServer.config.bind')}</legend>
        {BINDS.map((option) => (
          <label key={option.id} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={bindName}
              value={option.id}
              checked={bind === option.id}
              onChange={() => setBind(option.id)}
              className="mt-1"
            />
            <span>
              <span className="block">{t(option.label)}</span>
              <span className="block text-xs text-zinc-500">{t(option.hint)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-1">
        <label htmlFor={portId} className="block text-xs text-zinc-500">
          {t('apiServer.config.port')}
        </label>
        <input
          id={portId}
          type="number"
          min={MIN_PORT}
          max={MAX_PORT}
          value={port}
          onChange={(event) => setPort(event.target.value)}
          className={`${input} max-w-32 tabular-nums`}
        />
        <p className="text-xs text-zinc-500">{t('apiServer.config.portHint')}</p>
      </div>

      <div className="space-y-1">
        <label htmlFor={keyId} className="block text-xs text-zinc-500">
          {t('apiServer.config.apiKey')}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={keyId}
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('apiServer.config.apiKeyPlaceholder')}
            onChange={(event) => setApiKey(event.target.value)}
            className={`${input} min-w-48 flex-1 font-mono`}
          />
          <button
            type="button"
            onClick={() => {
              setApiKey(generateApiKey());
              setShowKey(true);
            }}
            className={button}
          >
            {t('apiServer.config.generate')}
          </button>
          <button
            type="button"
            disabled={apiKey === ''}
            onClick={() => setShowKey((shown) => !shown)}
            className={button}
          >
            {showKey ? t('apiServer.config.hide') : t('apiServer.config.show')}
          </button>
          <CopyButton text={key} disabled={key === ''} />
        </div>
        <p className="text-xs text-zinc-500">{t('apiServer.config.apiKeyHint')}</p>
      </div>

      {bind === 'lan' ? (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('apiServer.config.lanWarning')}
        </p>
      ) : null}
      {!portValid ? <p className={warning}>{t('apiServer.config.invalidPort')}</p> : null}
      {!keyValid ? <p className={warning}>{t('apiServer.config.invalidKey')}</p> : null}
      {keyMissing ? <p className={warning}>{t('apiServer.config.keyRequired')}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!valid || saving}
          onClick={() => void save()}
          className={primaryButton}
        >
          {t('apiServer.config.save')}
        </button>
        {changed ? (
          <span className="text-xs text-zinc-500">{t('apiServer.config.unsaved')}</span>
        ) : done ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            {t('apiServer.config.saved')}
          </span>
        ) : null}
      </div>
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </section>
  );
}
