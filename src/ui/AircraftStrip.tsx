// filepath: src/ui/AircraftStrip.tsx
import type { Aircraft } from '@/types/aircraft';
import { typeData } from '@/game/constants';

const STATE_COLORS: Record<string, string> = {
  enroute: '#666',
  vectored: '#ffdd00',
  intercepting: '#4488ff',
  established: '#00cc66',
  landed: '#00ff88',
  goaround: '#ff3333',
};

const STATE_LABELS: Record<string, string> = {
  enroute: 'ENR',
  vectored: 'VCT',
  intercepting: 'INT',
  established: 'EST',
  landed: 'LND',
  goaround: 'G/A',
};

interface Props {
  aircraft: Aircraft[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function AircraftStrip({ aircraft, selectedId, onSelect }: Props) {
  const active = aircraft.filter((a) => a.state !== 'landed');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', flex: 1 }}>
      {active.length === 0 && (
        <div style={{ color: '#446644', fontSize: 11, textAlign: 'center', paddingTop: 16 }}>
          NO TRAFFIC
        </div>
      )}
      {active.map((ac) => {
        const selected = ac.id === selectedId;
        const fl = Math.round(ac.altitudeFt / 100);
        const stateColor = ac.conflict ? '#ff3333' : ac.warning ? '#ffaa00' : STATE_COLORS[ac.state] ?? '#666';
        const wake = typeData(ac.type).wake;

        return (
          <div
            key={ac.id}
            onClick={() => onSelect(ac.id)}
            style={{
              padding: '6px 8px',
              background: selected ? '#0a2a1a' : '#0d1a0f',
              border: `1px solid ${selected ? '#00ff88' : stateColor}`,
              cursor: 'pointer',
              borderRadius: 3,
              userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: selected ? '#00ff88' : '#ccc', fontWeight: 'bold', fontSize: 13 }}>
                {ac.callsign}
              </span>
              <span style={{
                color: '#000',
                background: stateColor,
                padding: '1px 5px',
                borderRadius: 2,
                fontSize: 10,
                fontWeight: 'bold',
              }}>
                {STATE_LABELS[ac.state] ?? ac.state.toUpperCase()}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 11, color: '#888', alignItems: 'center' }}>
              <span style={{ color: '#aaa' }}>{ac.type}</span>
              {/* Übernommener echter Flieger: Startplatz in der Farbe der echten Anflüge */}
              {ac.origin && <span style={{ color: '#78d7ff' }} title="Startplatz (echter Flug)">{ac.origin}</span>}
              {wake === 'H' && (
                <span style={{ color: '#000', background: '#ffaa00', padding: '0px 4px', borderRadius: 2, fontSize: 9, fontWeight: 'bold', letterSpacing: 0.5 }}>H</span>
              )}
              {wake === 'J' && (
                <span style={{ color: '#000', background: '#ff6666', padding: '0px 4px', borderRadius: 2, fontSize: 9, fontWeight: 'bold', letterSpacing: 0.5 }}>J</span>
              )}
              <span>FL{fl.toString().padStart(3, '0')}</span>
              <span>{Math.round(ac.speedKts)}kt</span>
              {ac.assignedRunway && (
                <span style={{ color: ac.clearedToLand ? '#00ff88' : '#4488ff' }}>
                  {ac.clearedToLand ? 'LND' : 'ILS'} {ac.assignedRunway}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
