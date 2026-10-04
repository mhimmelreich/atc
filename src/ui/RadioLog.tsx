// filepath: src/ui/RadioLog.tsx
import { useLayoutEffect, useRef } from 'react';
import type { RadioMessage } from '@/types/radio';

interface Props {
  messages: RadioMessage[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  height: number;
}

// Absender im Log: Approach blau, Turm gelb, Piloten grün, Hinweise des Spiels grau
const SENDER: Record<string, { label?: string; tag: string; text: string }> = {
  app:   { label: 'APP', tag: '#55bbff', text: '#a8d8ff' },
  twr:   { label: 'TWR', tag: '#e8b84a', text: '#f4dca0' },
  pilot: { tag: '#00cc66', text: '#b8e8c8' },
  info:  { label: 'INFO', tag: '#4a7a5a', text: '#7fa88c' },
};

/** Funk-Log unter dem Radar, Klick wählt den Flieger */
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
        const sender = SENDER[m.from === 'atc' ? m.station ?? 'app' : m.from];
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
            <span style={{ color: sender.tag, flexShrink: 0, width: 58, fontWeight: 'bold' }}>
              {sender.label ?? m.callsign}
            </span>
            <span style={{ color: sender.text, fontStyle: m.from === 'info' ? 'italic' : undefined }}>{m.text}</span>
          </div>
        );
      })}
    </div>
  );
}
