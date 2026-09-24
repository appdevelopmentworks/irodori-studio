/** A determinate progress bar (`thin`: a secondary one, e.g. sampling steps). */
export function ProgressBar({
  done,
  total,
  thin = false,
}: {
  done: number;
  total: number;
  thin?: boolean;
}) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={`${thin ? 'h-1' : 'h-1.5'} overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800`}
    >
      <div
        className={`h-full ${thin ? 'bg-sky-300' : 'bg-sky-500'} transition-[width]`}
        style={{ width: `${(100 * done) / Math.max(total, 1)}%` }}
      />
    </div>
  );
}
