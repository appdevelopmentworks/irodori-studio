'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { copyText } from '@/lib/clipboard';

import { button } from './ui';

const SHOWN_MS = 1500;

/** Copies `text`, then says so for a moment. */
export function CopyButton({
  text,
  disabled = false,
  className = button,
}: {
  text: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void copyText(text).then(setCopied)}
      className={className}
    >
      {copied ? t('common.actions.copied') : t('common.actions.copy')}
    </button>
  );
}
