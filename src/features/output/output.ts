// Export settings shared by every screen (D20): kept in the sidecar's preferences.
import type { AudioFormat, OutputOptions, PostOptions } from '@/lib/types';

export const FORMATS: AudioFormat[] = ['wav', 'mp3', 'm4a', 'flac', 'opus'];

export const DEFAULT_OUTPUT: OutputOptions = {
  format: 'wav',
  sample_rate: 48000,
  loudness: null,
  tempo: 1,
  gain_db: 0,
};

/** What an export can use: without ffmpeg, only WAV as generated. */
export function usableOutput(output: OutputOptions | null | undefined, ffmpeg: boolean): OutputOptions {
  return ffmpeg && output ? output : DEFAULT_OUTPUT;
}

/** The post-processing part of an export request; null when it changes nothing. */
export function postOf(output: OutputOptions): PostOptions | null {
  const { sample_rate, loudness, tempo, gain_db } = output;
  if (sample_rate === 48000 && loudness === null && tempo === 1 && gain_db === 0) return null;
  return { sample_rate, loudness, tempo, gain_db };
}

/** Opus is always 48 kHz (its encoder has no 44.1 kHz mode). */
export const rateOf = (output: OutputOptions) =>
  output.format === 'opus' ? 48000 : output.sample_rate;
