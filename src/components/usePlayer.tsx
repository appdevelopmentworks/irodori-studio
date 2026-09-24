'use client';

import { useRef, useState } from 'react';

/** One shared player for many takes, one at a time. Render `element` once; it stops when
 * the screen goes away (a removed media element pauses). */
export function usePlayer(url: ((audioId: string) => string) | null) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const toggle = (audioId: string) => {
    const element = audio.current;
    if (!element || !url) return;
    if (playing === audioId && !element.paused) {
      element.pause();
      setPlaying(null);
      return;
    }
    element.src = url(audioId);
    setPlaying(audioId);
    element.play().catch(() => setPlaying(null));
  };
  // Generated speech has no caption track; its text is shown beside the button.
  const element = <audio ref={audio} preload="none" hidden onEnded={() => setPlaying(null)} />;
  return { playing, toggle, element };
}
