interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
export interface SpeechEnvironment {
  createRecognition?: () => Recognition;
  synthesis?: Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'>;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
}
interface SpeechEvents {
  onListening: (value: boolean) => void;
  onSpeaking: (key: string | null) => void;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

export function browserSpeechEnvironment(win: Window): SpeechEnvironment {
  const browser = win as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition;
    SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance };
  const RecognitionClass = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  return { createRecognition: RecognitionClass ? () => new RecognitionClass() : undefined,
    synthesis: browser.speechSynthesis,
    createUtterance: browser.SpeechSynthesisUtterance ? text => new browser.SpeechSynthesisUtterance!(text) : undefined };
}

// Keep ordinary words, decimal strengths and ratios together. The bound is a
// conservative playback chunk size, not a promise about any browser's limit.
export function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  const append = (part: string) => {
    if (chunk.length + part.length > 240) { chunks.push(chunk); chunk = ''; }
    chunk += part;
    if ((part.includes('\n') && chunk.trim()) || (chunk.length >= 120 && /^(?:\s+|[。！？!?；;])$/u.test(part))) {
      chunks.push(chunk); chunk = '';
    }
  };
  for (const match of text.trim().matchAll(/\s+|[A-Za-z0-9]+(?:[.,:/+%µμ°-][A-Za-z0-9]+)*|[^\s]/gu)) {
    const part = match[0];
    if (part.length <= 240) append(part);
    else for (const character of part) append(character); // Do not split surrogate pairs.
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

// Each callback belongs to its original operation. Cancel before changing the
// consultation so queued browser events cannot write into another person's draft.
export function createSpeechController(env: SpeechEnvironment, events: SpeechEvents) {
  let recognition: Recognition | undefined;
  let utterance: SpeechSynthesisUtterance | undefined;
  let playback: { key: string; chunks: string[]; next: number } | undefined;
  const cancelListening = () => {
    const previous = recognition; recognition = undefined;
    try { previous?.abort(); } catch { /* Already stopped by the browser. */ }
    events.onListening(false);
  };
  const stopSpeaking = (key?: string) => {
    if (key !== undefined && playback?.key !== key) return;
    utterance = undefined; playback = undefined;
    try { env.synthesis?.cancel(); } catch { /* Playback is no longer available. */ }
    events.onSpeaking(null);
  };
  const toggleListening = () => {
    if (recognition) {
      try { recognition.stop(); } catch { cancelListening(); }
      return;
    }
    if (!env.createRecognition) { events.onError('此瀏覽器不支援語音輸入，請改用文字輸入。'); return; }
    stopSpeaking();
    try {
      const active = recognition = env.createRecognition();
      active.lang = 'zh-TW'; active.continuous = false; active.interimResults = false;
      active.onstart = () => { if (recognition === active) events.onListening(true); };
      active.onresult = event => {
        if (recognition !== active) return;
        const text = event.results[0]?.[0]?.transcript?.trim();
        if (text) events.onTranscript(text);
      };
      active.onend = () => { if (recognition === active) { recognition = undefined; events.onListening(false); } };
      active.onerror = event => {
        if (recognition !== active) return;
        cancelListening();
        if (event.error !== 'aborted') events.onError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? '無法使用麥克風或語音服務。請確認此網站的權限，或改用文字輸入。'
          : event.error === 'no-speech' ? '沒有聽到清楚的語音，請再試一次，或改用文字輸入。'
          : event.error === 'audio-capture' ? '找不到可用的麥克風，請確認裝置或改用文字輸入。'
          : '語音辨識未完成，請檢查連線後重試，或改用文字輸入。');
      };
      events.onListening(true);
      active.start();
    } catch {
      cancelListening(); events.onError('無法啟動語音輸入，請稍後重試或改用文字輸入。');
    }
  };
  const toggleSpeech = (text: string, key = text) => {
    const same = playback?.key === key;
    stopSpeaking();
    if (same || !text.trim()) return;
    if (!env.synthesis || !env.createUtterance) { events.onError('此瀏覽器不支援語音播放，仍可閱讀回答內容。'); return; }
    cancelListening();
    const current = playback = { key, chunks: speechChunks(text).filter(chunk => chunk.trim()), next: 0 };
    const playNext = () => {
      if (playback !== current) return;
      if (current.next === current.chunks.length) {
        utterance = undefined; playback = undefined; events.onSpeaking(null); return;
      }
      try {
        const active = utterance = env.createUtterance!(current.chunks[current.next++]);
        active.lang = 'zh-TW';
        const voice = env.synthesis!.getVoices().find(v => v.lang === 'zh-TW');
        if (voice) active.voice = voice;
        active.onend = () => {
          if (playback !== current || utterance !== active) return;
          utterance = undefined; playNext();
        };
        active.onerror = () => {
          if (playback !== current || utterance !== active) return;
          stopSpeaking(); events.onError('語音播放未完成，可重新播放或直接閱讀回答。');
        };
        env.synthesis!.speak(active);
      } catch {
        stopSpeaking(); events.onError('語音播放未完成，仍可閱讀回答內容或重新播放。');
      }
    };
    events.onSpeaking(key);
    playNext();
  };
  return { toggleListening, toggleSpeech, cancelListening, stopSpeaking,
    cancel: () => { cancelListening(); stopSpeaking(); } };
}
