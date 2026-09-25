'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { ProgressBar } from '@/components/ProgressBar';
import { button, dangerButton, primaryButton } from '@/components/ui';
import { errorCodeOf } from '@/lib/errors';
import { formatBytes, formatMemory } from '@/lib/format';
import { repairInstallation, setRuntime } from '@/lib/tauri';
import type { Device, ModelInfo, Precision } from '@/lib/types';
import { useSettingsStore } from '@/store/settings';
import { useSidecarStore } from '@/store/sidecar';

import { Section } from './Section';

const MB = 1024 * 1024;
const select =
  'rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';

export function EngineTab() {
  return (
    <div className="space-y-6">
      <ModelSection />
      <RuntimeSection />
      <MonitorSection />
      <RepairSection />
    </div>
  );
}

/** The resident model (D4, D5): name, files on disk, state and runtime. */
function ModelSection() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const api = useSidecarStore((s) => s.api);
  const engine = useSidecarStore((s) => s.engine);
  const [models, setModels] = useState<ModelInfo[] | null>(null);

  useEffect(() => {
    if (!api) return;
    api
      .getModels()
      .then(setModels)
      .catch(() => undefined);
  }, [api]);

  return (
    <Section title={t('settings.model.title')} description={t('settings.model.hint')}>
      <ul className="space-y-2 text-sm">
        {(models ?? []).map((model) => (
          <li key={model.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{model.display_name}</span>
            <span className="font-mono text-xs text-zinc-500">{model.id}</span>
            <span className="text-xs text-zinc-500 tabular-nums">
              {t('settings.model.size', {
                size: formatBytes(model.size_bytes_approx, locale),
              })}
            </span>
            <span className="text-xs">
              {model.active && engine
                ? t(`shell.status.engine.${engine.state}`)
                : model.installed
                  ? t('settings.model.installed')
                  : t('settings.model.missing')}
            </span>
          </li>
        ))}
      </ul>
      {engine?.runtime ? (
        <p className="text-xs text-zinc-500">
          {t('settings.model.runtime', {
            device: t(`setup.environment.modes.${engine.runtime.device}`),
            precision: engine.runtime.model_precision,
          })}
        </p>
      ) : null}
    </Section>
  );
}

/** Device and precision over the setup plan (D9); applying restarts the engine. */
function RuntimeSection() {
  const { t } = useTranslation();
  const deviceId = useId();
  const precisionId = useId();
  const runtime = useSettingsStore((s) => s.info?.runtime ?? null);
  const [device, setDevice] = useState<Device | null>(null);
  const [precision, setPrecision] = useState<Precision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  if (!runtime?.installed_device || !runtime.installed_precision) return null;
  const installed = {
    device: runtime.installed_device,
    precision: runtime.installed_precision,
  };
  const current = runtime.selected ?? installed;
  const chosenDevice = device ?? current.device;
  const precisions: Precision[] =
    chosenDevice === 'cuda' && runtime.bf16 ? ['fp32', 'bf16'] : ['fp32'];
  const wanted = precision ?? current.precision;
  const chosenPrecision = precisions.includes(wanted) ? wanted : 'fp32';
  const changed = chosenDevice !== current.device || chosenPrecision !== current.precision;
  const asSetUp = chosenDevice === installed.device && chosenPrecision === installed.precision;

  const apply = async (value: { device: Device; precision: Precision } | null) => {
    setApplying(true);
    setError(null);
    try {
      await setRuntime(value);
    } catch (err) {
      setError(errorCodeOf(err));
      setApplying(false);
    }
  };

  return (
    <Section title={t('settings.runtime.title')} description={t('settings.runtime.hint')}>
      <p className="text-sm">
        {t('settings.runtime.installed', {
          device: t(`setup.environment.modes.${installed.device}`),
          precision: installed.precision,
        })}
        {runtime.torch_version ? (
          <span className="ml-2 font-mono text-xs text-zinc-500">{runtime.torch_version}</span>
        ) : null}
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <label htmlFor={deviceId} className="block text-xs text-zinc-500">
            {t('settings.runtime.device')}
          </label>
          <select
            id={deviceId}
            value={chosenDevice}
            disabled={runtime.devices.length < 2}
            onChange={(event) => setDevice(event.target.value as Device)}
            className={select}
          >
            {runtime.devices.map((id) => (
              <option key={id} value={id}>
                {t(`setup.environment.modes.${id}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={precisionId} className="block text-xs text-zinc-500">
            {t('settings.runtime.precision')}
          </label>
          <select
            id={precisionId}
            value={chosenPrecision}
            disabled={precisions.length < 2}
            onChange={(event) => setPrecision(event.target.value as Precision)}
            className={select}
          >
            {precisions.map((id) => (
              <option key={id} value={id}>
                {t(`settings.runtime.precisions.${id}`)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={!changed || applying}
          onClick={() =>
            void apply(asSetUp ? null : { device: chosenDevice, precision: chosenPrecision })
          }
          className={primaryButton}
        >
          {t('settings.runtime.apply')}
        </button>
        {runtime.selected ? (
          <button
            type="button"
            disabled={applying}
            onClick={() => void apply(null)}
            className={button}
          >
            {t('settings.runtime.reset')}
          </button>
        ) : null}
      </div>
      {chosenDevice === 'cpu' ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('shell.status.cpuMode')}</p>
      ) : null}
      <p className="text-xs text-zinc-500">{t('settings.runtime.restartNote')}</p>
      {runtime.devices.length < 2 ? (
        <p className="text-xs text-zinc-500">{t('settings.runtime.cpuOnly')}</p>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </Section>
  );
}

function MemoryBar({ label, used, total }: { label: string; used: number; total: number }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-3 text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="tabular-nums">
          {t('settings.monitor.usage', {
            used: formatMemory(used * MB, locale),
            total: formatMemory(total * MB, locale),
          })}
        </span>
      </div>
      <ProgressBar done={used} total={total} />
    </div>
  );
}

/** GPU and memory, refreshed with the status bar's poll (every 2 s). */
function MonitorSection() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const api = useSidecarStore((s) => s.api);
  const system = useSidecarStore((s) => s.system);
  const [cleared, setCleared] = useState(false);

  if (!system) return null;
  const { device, memory, torch } = system;
  const mb = (value: number) => formatMemory(value * MB, locale);

  return (
    <Section title={t('settings.monitor.title')} description={t('settings.monitor.hint')}>
      <p className="text-sm">
        {[device.name, t(`setup.environment.modes.${device.kind}`), device.precision]
          .filter(Boolean)
          .join(' · ')}
        {device.compute_capability ? (
          <span className="ml-2 text-xs text-zinc-500">
            {t('settings.monitor.capability', {
              value: device.compute_capability,
            })}
          </span>
        ) : null}
      </p>
      <div className="space-y-3">
        {device.kind === 'cuda' &&
        device.memory_used_mb != null &&
        device.memory_total_mb != null ? (
          <MemoryBar
            label={t('settings.monitor.vram')}
            used={device.memory_used_mb}
            total={device.memory_total_mb}
          />
        ) : null}
        {memory.system_used_mb != null && memory.system_total_mb != null ? (
          <MemoryBar
            label={t('settings.monitor.ram')}
            used={memory.system_used_mb}
            total={memory.system_total_mb}
          />
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {memory.accelerator_allocated_mb != null ? (
          <>
            <dt className="text-zinc-500">{t('settings.monitor.torch')}</dt>
            <dd className="tabular-nums">
              {t('settings.monitor.torchValue', {
                allocated: mb(memory.accelerator_allocated_mb),
                reserved: mb(memory.accelerator_reserved_mb ?? memory.accelerator_allocated_mb),
              })}
            </dd>
          </>
        ) : null}
        {memory.process_mb != null ? (
          <>
            <dt className="text-zinc-500">{t('settings.monitor.process')}</dt>
            <dd className="tabular-nums">{mb(memory.process_mb)}</dd>
          </>
        ) : null}
        {torch ? (
          <>
            <dt className="text-zinc-500">{t('settings.monitor.versions')}</dt>
            <dd className="font-mono">
              {[`torch ${torch.version}`, torch.cuda_version ? `CUDA ${torch.cuda_version}` : null]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </>
        ) : null}
      </dl>
      {device.kind !== 'cpu' ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!api}
            onClick={() => {
              setCleared(false);
              api
                ?.clearAcceleratorCache()
                .then(() => {
                  setCleared(true);
                  return useSidecarStore.getState().poll();
                })
                .catch(() => undefined);
            }}
            className={button}
          >
            {t('settings.monitor.clear')}
          </button>
          {cleared ? (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">
              {t('settings.monitor.cleared')}
            </span>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

/** Setup again for what a repair can fix; the wizard shows it, then the app restarts. */
function RepairSection() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Section title={t('settings.repair.title')} description={t('settings.repair.hint')}>
      {confirming ? (
        <div className="space-y-2">
          <p className="text-sm">{t('settings.repair.confirm')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                repairInstallation().catch((err: unknown) => setError(errorCodeOf(err)))
              }
              className={dangerButton}
            >
              {t('settings.repair.start')}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={button}>
              {t('settings.common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={button}>
          {t('settings.repair.button')}
        </button>
      )}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </Section>
  );
}
