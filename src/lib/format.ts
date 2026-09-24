// Locale-aware number formatting (docs/coding-conventions.md: numbers via Intl).

const GB = 1_000_000_000;
const MB = 1_000_000;

/** "3.6 GB" / "3,6 GB" / "850 MB" in the active locale. */
export function formatBytes(bytes: number, locale: string): string {
  const [value, unit] = bytes >= GB ? [bytes / GB, 'gigabyte'] : [bytes / MB, 'megabyte'];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

/** RAM / VRAM in binary units, as vendors label them ("32 GB" for 32 GiB). */
export function formatMemory(bytes: number, locale: string): string {
  const gib = bytes / 1024 ** 3;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'gigabyte',
    unitDisplay: 'short',
    maximumFractionDigits: gib >= 10 ? 0 : 1,
  }).format(gib);
}

/** A duration in seconds as a plain number ("4.04" / "4,04"); the unit is in the copy. */
export function formatSeconds(seconds: number, locale: string, fractionDigits = 1): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(seconds);
}

export function formatPercent(done: number, total: number, locale: string): string {
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    ratio,
  );
}

/** A timestamp (ISO 8601) as a medium date and short time in the active locale. */
export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** A duration as a clock: "3:05", or "1:02:03" from an hour on. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}
