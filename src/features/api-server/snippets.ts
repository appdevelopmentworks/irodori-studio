// API key helpers and the usage example of the API Server screen. The example is code,
// not app copy; its sample input is Japanese in every locale (the model reads Japanese).

export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** Visible ASCII without spaces, 8–200 characters, as the sidecar checks: the key travels
 * in an HTTP header. */
const KEY_PATTERN = /^[!-~]{8,200}$/;

export const isValidApiKey = (key: string): boolean => KEY_PATTERN.test(key);

/** A random key: 24 bytes as URL-safe base64 (32 characters). */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

const SAMPLE_INPUT = 'こんにちは。今日はいい天気ですね。';

/** The OpenAI Python SDK example of Irodori-TTS-Server, pointed at this app. JSON string
 * literals are valid Python string literals. */
export function openaiExample(baseUrl: string, keySet: boolean, voice: string): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url=${quote(`${baseUrl}/v1`)}, api_key=${quote(keySet ? 'YOUR_API_KEY' : 'unused')})`,
    '',
    'with client.audio.speech.with_streaming_response.create(',
    '    model="irodori-tts",',
    `    voice=${quote(voice)},`,
    `    input=${quote(SAMPLE_INPUT)},`,
    '    response_format="wav",',
    '    extra_body={"irodori": {"seed": 42}},',
    ') as response:',
    '    response.stream_to_file("speech.wav")',
  ].join('\n');
}
