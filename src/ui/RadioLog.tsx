// filepath: src/ui/RadioLog.tsx
import { useLayoutEffect, useRef } from 'react';
import type { RadioMessage } from '@/types/radio';

interface Props {
  messages: RadioMessage[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  height: number;
}

/** Funk-Log unter dem Radar: Lotse blau, Piloten grün, Klick wählt den Flieger */
export function RadioLog({ messages, selectedId, onSelect, height }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Nur mitscrollen, solange man unten ist (beim Zurückblättern nicht wegspringen)
  const stickRef = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      style={{
        height, flexShrink: 0, overflowY: 'auto',
        background: '#030a05', borderTop: '1px solid #0a2010',
        padding: '3px 8px', fontSize: 11, lineHeight: '15px',
      }}
    >
      {messages.length === 0 && <div style={{ color: '#2a5535', letterSpacing: 1 }}>FREQUENCY QUIET</div>}
      {messages.map((m) => {
        const atc = m.from === 'atc';
        return (
          <div
            key={m.id}
            onClick={() => m.aircraftId && onSelect(m.aircraftId)}
            style={{
              display: 'flex', gap: 8, cursor: m.aircraftId ? 'pointer' : 'default',
              background: m.aircraftId && m.aircraftId === selectedId ? '#0a1f12' : undefined,
            }}
          >
            <span style={{ color: '#2a5535', flexShrink: 0 }}>{new Date(m.ts).toISOString().slice(11, 19)}</span>
            <span style={{ color: atc ? '#55bbff' : '#00cc66', flexShrink: 0, width: 58, fontWeight: 'bold' }}>
              {atc ? 'ATC' : m.callsign}
            </span>
            <span style={{ color: atc ? '#a8d8ff' : '#b8e8c8' }}>{m.text}</span>
          </div>
        );
      })}
    </div>
  );
}
