// filepath: src/ui/WatchMenu.tsx
// WATCH: Kontextmenü (rechte Maustaste) auf einem echten Flieger: Kamera folgen lassen bzw. beenden
import { useEffect, useRef } from 'react';

export interface WatchMenuState { x: number; y: number; id: string; callsign: string }

interface Props {
  menu: WatchMenuState;
  following: boolean;
  onFollow: (on: boolean) => void;
  onClose: () => void;
}

const ITEM: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
  color: '#00ff88', fontFamily: '"Courier New", monospace', fontSize: 12, padding: '6px 10px', cursor: 'pointer',
};

export function WatchMenu({ menu, following, onFollow, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [onClose]);
  const x = Math.max(4, Math.min(menu.x, window.innerWidth - 190));
  const y = Math.max(4, Math.min(menu.y, window.innerHeight - 90));
  return (
    <div ref={ref} style={{ position: 'fixed', left: x, top: y, zIndex: 50, width: 180, background: '#06140c', border: '1px solid #1a4428', boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
      <div style={{ padding: '6px 10px', color: '#7fd8a8', fontFamily: '"Courier New", monospace', fontSize: 12, borderBottom: '1px solid #1a4428' }}>{menu.callsign}</div>
      <button style={ITEM} onClick={() => { onFollow(!following); onClose(); }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#0d2a18')} onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
        {following ? '■ FOLGEN BEENDEN' : '▶ KAMERA FOLGEN'}
      </button>
    </div>
  );
}
