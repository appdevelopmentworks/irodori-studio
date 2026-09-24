'use client';

import { useTranslation } from 'react-i18next';

import { pickDirectory } from '@/lib/tauri';
import { useQuickStore } from '@/store/quick';

/** Per-request LoRA adapter (a request field, not a sampling parameter). */
export function LoraField() {
  const { t } = useTranslation();
  const loraPath = useQuickStore((s) => s.loraPath);
  const setLoraPath = useQuickStore((s) => s.setLoraPath);

  const choose = async () => {
    const path = await pickDirectory(t('quick.lora.chooseTitle'), loraPath ?? undefined);
    if (path) setLoraPath(path);
  };

  return (
    <div className="space-y-1.5 md:col-span-2">
      <p className="text-sm font-medium">{t('quick.lora.label')}</p>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate rounded-md border border-zinc-300 px-2 py-1.5 font-mono text-xs dark:border-zinc-700">
          {loraPath ?? t('quick.lora.none')}
        </p>
        <button
          type="button"
          onClick={choose}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {t('quick.lora.choose')}
        </button>
        {loraPath ? (
          <button
            type="button"
            onClick={() => setLoraPath(null)}
            className="rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            {t('quick.lora.clear')}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-zinc-500">{t('quick.lora.help')}</p>
    </div>
  );
}
