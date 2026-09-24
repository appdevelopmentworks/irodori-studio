// Microphone capture for the recording guide: raw PCM from an AudioWorklet (no lossy
// MediaRecorder codec), written as WAV and uploaded as a clip with origin "recording".
import { encodeWav } from '@/lib/wav';

export interface MicLevel {
  /** Peak amplitude of the last block, 0..1. */
  peak: number;
  /** RMS of the last block, 0..1. */
  rms: number;
}

export type MicError = 'denied' | 'noDevice' | 'busy' | 'unsupported' | 'failed';

// Runs on the audio rendering thread: forwards ~50 ms mono blocks with their levels.
const PROCESSOR = `
class IrodoriRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.size = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.post();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  post() {
    if (this.size === 0) return;
    const samples = new Float32Array(this.size);
    let offset = 0;
    let peak = 0;
    let squares = 0;
    for (const block of this.blocks) {
      samples.set(block, offset);
      offset += block.length;
    }
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
      squares += samples[i] * samples[i];
    }
    this.port.postMessage(
      { samples, peak, rms: Math.sqrt(squares / samples.length) },
      [samples.buffer],
    );
    this.blocks = [];
    this.size = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) {
        for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      }
      this.blocks.push(mono);
      this.size += mono.length;
      if (this.size >= sampleRate / 20) this.post();
    }
    return true;
  }
}
registerProcessor('irodori-recorder', IrodoriRecorder);
`;

interface Block {
  samples?: Float32Array;
  peak?: number;
  rms?: number;
  flushed?: boolean;
}

export function micErrorOf(err: unknown): MicError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noDevice';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  if (name === 'NotSupportedError') return 'unsupported';
  return 'failed';
}

/** One take: open the microphone, collect PCM until `stop()`, then release it. */
export class MicRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private frames = 0;
  private onFlushed: (() => void) | null = null;

  constructor(private readonly onLevel: (level: MicLevel, seconds: number) => void) {}

  static supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioWorkletNode !== 'undefined'
    );
  }

  async start(): Promise<void> {
    if (!MicRecorder.supported()) throw new DOMException('unsupported', 'NotSupportedError');
    // Voice cloning wants the raw voice: no echo cancellation, suppression or gain riding.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    try {
      const context = new AudioContext();
      this.context = context;
      const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const source = context.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(context, 'irodori-recorder');
      node.port.onmessage = (event: MessageEvent<Block>) => {
        const block = event.data;
        if (block.flushed) {
          this.onFlushed?.();
          return;
        }
        if (!block.samples) return;
        this.chunks.push(block.samples);
        this.frames += block.samples.length;
        this.onLevel(
          { peak: block.peak ?? 0, rms: block.rms ?? 0 },
          this.frames / context.sampleRate,
        );
      };
      // A silent path to the output keeps the graph pulling the worklet.
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      this.node = node;
      if (context.state === 'suspended') await context.resume();
    } catch (err) {
      await this.release();
      throw err;
    }
  }

  /** Stop and return the take as WAV (null when nothing was captured). */
  async stop(): Promise<{ wav: Blob; seconds: number } | null> {
    const node = this.node;
    const context = this.context;
    if (node && context) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        this.onFlushed = () => {
          clearTimeout(timer);
          resolve();
        };
        node.port.postMessage('flush');
      });
    }
    const rate = context?.sampleRate ?? 48000;
    const take =
      this.frames > 0
        ? { wav: encodeWav(this.chunks, rate), seconds: this.frames / rate }
        : null;
    await this.release();
    return take;
  }

  /** Discard the take and release the microphone. */
  async cancel(): Promise<void> {
    await this.release();
  }

  private async release(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    this.chunks = [];
    this.frames = 0;
    this.onFlushed = null;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }
}
