import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Square, Volume2 } from 'lucide-react';
import MarkdownContent from './MarkdownContent';

export default function SpokenAnswer({ children, heading, speakingKey, onSpeak, onStop }: {
  children: string;
  heading?: ReactNode;
  speakingKey: string | null;
  onSpeak: (text: string, key: string) => void;
  onStop: (key: string) => void;
}) {
  const key = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const active = speakingKey === key;
  // A removed/replaced answer must not continue reading after its controls vanish.
  useEffect(() => () => onStop(key), [children, key, onStop]);
  const indicator = active && <div className="flex items-end gap-0.5 h-4" aria-hidden="true">
    <div className="wave-bar" /><div className="wave-bar" /><div className="wave-bar" /><div className="wave-bar" />
  </div>;
  return <>
    <div className={`flex items-center justify-between ${heading ? 'mb-4' : 'mb-2'}`}>
      {heading || <div>{indicator}</div>}
      <div className="flex items-center gap-4">
        {heading && indicator}
        <button type="button" onClick={() => onSpeak(contentRef.current?.innerText || '', key)}
          className={heading ? 'p-2 bg-emerald-50 text-emerald-600 rounded-xl hover:bg-emerald-100 transition-all shadow-sm' : 'p-1 text-slate-400 hover:text-emerald-600 transition-colors'}
          title={active ? '停止播放' : '語音播放'} aria-label={active ? '停止播放' : '語音播放'} aria-pressed={active}>
          {active ? <Square size={heading ? 18 : 14} fill="currentColor" /> : <Volume2 size={heading ? 18 : 14} />}
        </button>
      </div>
    </div>
    <MarkdownContent contentRef={contentRef}>{children}</MarkdownContent>
  </>;
}
