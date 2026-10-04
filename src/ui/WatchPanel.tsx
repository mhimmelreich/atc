// filepath: src/ui/WatchPanel.tsx
// WATCH: echter Verkehr zum Zuschauen – gewählter Flieger mit allen Daten, darunter alle Flieger nach Entfernung
import type { Airport } from '@/types/airport';
import type { LiveAircraft, LiveInbound } from '@/types/live';
import { bearingBetween, distanceNM } from '@/utils/geo';

interface Props {
  aircraft: LiveAircraft[];
  roles: Record<string, LiveInbound>;
  airport: Airport | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const MAX_LIST = 40;
const COLOR = { in: '#78d7ff', out: '#ffbe5a', other: '#aabeb4' };

const roleColor = (r?: LiveInbound) => (r?.out ? COLOR.out : r ? COLOR.in : COLOR.other);
const roleText = (r?: LiveInbound) => (r?.out ? `→ ${r.dest ?? '?'}` : r ? `${r.guess ? '?' : r.origin ?? '?'} →` : '');
const fl = (ft: number | null) => (ft === null ? '---' : ft < 6000 ? `${Math.round(ft / 100) * 100} ft` : `FL${Math.round(ft / 100).toString().padStart(3, '0')}`);
const vsArrow = (vs: number | null) => ((vs ?? 0) > 300 ? '↑' : (vs ?? 0) < -300 ? '↓' : '→');

export function WatchPanel({ aircraft, roles, airport, selectedId, onSelect }: Props) {
  const dist = (ac: LiveAircraft) => (airport ? distanceNM(airport.lat, airport.lng, ac.lat, ac.lng) : 0);
  const list = [...aircraft].sort((a, b) => dist(a) - dist(b)).slice(0, MAX_LIST);
  const sel = aircraft.find((ac) => `live-${ac.hex}` === selectedId);

  return (
    <>
      <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1 }}>SELECTED</div>
      {sel ? <Details ac={sel} role={roles[sel.hex]} airport={airport} /> : (
        <div style={{ color: '#446644', fontSize: 11, padding: '4px 0' }}>Flieger auf dem Radar oder in der Liste anklicken</div>
      )}

      <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, display: 'flex', justifyContent: 'space-between' }}>
        <span>LIVE TRAFFIC ({aircraft.length})</span>
        <span><span style={{ color: COLOR.in }}>■ IN</span> <span style={{ color: COLOR.out }}>■ OUT</span></span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', flex: 1, minHeight: 110 }}>
        {list.length === 0 && <div style={{ color: '#446644', fontSize: 11, textAlign: 'center', paddingTop: 16 }}>NO TRAFFIC</div>}
        {list.map((ac) => {
          const id = `live-${ac.hex}`;
          const role = roles[ac.hex];
          const selected = id === selectedId;
          return (
            <div
              key={ac.hex}
              onClick={() => onSelect(id)}
              style={{
                display: 'grid', gridTemplateColumns: '1fr 60px 42px', gap: 4, alignItems: 'baseline',
                padding: '3px 6px', fontSize: 11, cursor: 'pointer', userSelect: 'none', borderRadius: 2,
                background: selected ? '#0a2a1a' : '#0d1a0f',
                border: `1px solid ${selected ? '#00ff88' : '#0f2416'}`,
              }}
            >
              <span style={{ color: roleColor(role), fontWeight: 'bold', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {ac.callsign} <span style={{ fontWeight: 'normal', color: '#6a8a76' }}>{roleText(role)}</span>
              </span>
              <span style={{ color: '#9ab', textAlign: 'right' }}>{fl(ac.altFt)} {vsArrow(ac.vs)}</span>
              <span style={{ color: '#6a8a76', textAlign: 'right' }}>{Math.round(dist(ac))} NM</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Details({ ac, role, airport }: { ac: LiveAircraft; role?: LiveInbound; airport: Airport | null }) {
  const d = airport ? distanceNM(airport.lat, airport.lng, ac.lat, ac.lng) : null;
  const brg = airport ? Math.round(bearingBetween(airport.lat, airport.lng, ac.lat, ac.lng)) : null;
  const age = Math.max(0, Math.round((Date.now() - ac.ts) / 1000));
  const rows: Array<[string, string]> = [
    ['TYPE', [ac.type, ac.reg].filter(Boolean).join(' · ') || '—'],
    ['ROUTE', ac.route?.replace(/-/g, ' → ') ?? '—'],
    ['ALT', `${fl(ac.altFt)}${ac.selAltFt !== undefined ? `  (SEL ${fl(ac.selAltFt)})` : ''}`],
    ['V/S', ac.vs === null ? '—' : `${ac.vs > 0 ? '+' : ''}${Math.round(ac.vs / 100) * 100} ft/min`],
    ['GS', ac.gs === null ? '—' : `${Math.round(ac.gs)} kt`],
    ['TRACK', ac.track === null ? '—' : `${Math.round(ac.track).toString().padStart(3, '0')}°`],
    ['SQUAWK', ac.squawk ?? '—'],
    ['POS', d === null ? '—' : `${Math.round(d)} NM, ${brg!.toString().padStart(3, '0')}° von ${airport!.icao}`],
    ['DATA', `${age} s alt`],
  ];
  return (
    <div style={{ background: '#0d1a0f', border: `1px solid ${roleColor(role)}`, borderRadius: 3, padding: '6px 8px', fontSize: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: roleColor(role), fontWeight: 'bold', fontSize: 13 }}>{ac.callsign}</span>
        <span style={{ color: '#6a8a76' }}>{role?.out ? 'ABFLUG' : role ? 'ANFLUG' : 'ANDERER'}</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: '#446644', width: 52, flexShrink: 0 }}>{k}</span>
          <span style={{ color: '#cde' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}
