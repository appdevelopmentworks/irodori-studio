// Emotion / style presets for the caption (requirements §6.3). The caption is model
// input, so it is Japanese in every locale; only the button label is translated
// (`quick.stylePresets.<id>`). They describe manner and mood rather than timbre, so they
// also combine well with reference audio (model card: "Conditioning Conflicts").
export const STYLE_PRESETS = [
  { id: 'calm', caption: '落ち着いた自然な声で、穏やかに話している。' },
  { id: 'bright', caption: '明るく元気な声で、楽しそうに話している。' },
  { id: 'gentle', caption: '優しく柔らかい声で、語りかけるように話している。' },
  { id: 'whisper', caption: '耳元でささやくような、小さく近い声。' },
  { id: 'sad', caption: '悲しげで沈んだ声。今にも泣き出しそうに話している。' },
  { id: 'angry', caption: '怒っていて、強くとげのある口調で話している。' },
  { id: 'excited', caption: '興奮気味で、勢いよく早口で話している。' },
  { id: 'sleepy', caption: '眠そうで気だるげな、ゆっくりとした声。' },
  { id: 'narration', caption: '落ち着いたナレーション。はっきりと聞き取りやすく読み上げている。' },
  { id: 'announcer', caption: 'ニュースを読み上げるアナウンサーのような、明瞭で落ち着いた声。' },
] as const;

export type StylePresetId = (typeof STYLE_PRESETS)[number]['id'];
