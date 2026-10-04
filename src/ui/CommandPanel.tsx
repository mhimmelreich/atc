// filepath: src/ui/CommandPanel.tsx
import { useState } from 'react';
import type { Aircraft, ATCCommand } from '@/types/aircraft';
import type { Airport } from '@/types/airport';
import { getILSStatusForRunway } from '@/game/ILS';
import { stations } from '@/game/Phraseology';

interface Props {
  selected: Aircraft | undefined;
  airport: Airport | null;
  onCommand: (id: string, cmd: ATCCommand) => void;
  activeRunwayIds?: string[];
  /** Befehlsarten, die der Pilot noch nicht ausgeführt hat */
  pendingCmdTypes?: string[];
}

const INPUT_STYLE: React.CSSProperties = {
  background: '#0a1a10',
  border: '1px solid #1a4428',
  color: '#00ff88',
  padding: '6px 8px',
  fontFamily: '"Courier New", monospace',
  fontSize: 14,
  width: '100%',
  outline: 'none',
  borderRadius: 3,
};

const BTN_STYLE: React.CSSProperties = {
  background: '#0d2a18',
  border: '1px solid #00cc66',
  color: '#00ff88',
  padding: '7px 10px',
  fontFamily: '"Courier New", monospace',
  fontSize: 13,
  cursor: 'pointer',
  borderRadius: 3,
  width: '100%',
  marginTop: 3,
};

const LABEL_STYLE: React.CSSProperties = {
  color: '#446644',
  fontSize: 10,
  letterSpacing: 1,
  marginBottom: 3,
  display: 'block',
};

export function CommandPanel({ selected, airport, onCommand, activeRunwayIds = [], pendingCmdTypes = [] }: Props) {
  const [hdg, setHdg] = useState('');
  const [alt, setAlt] = useState('');
  const [spd, setSpd] = useState('');

  if (!selected) {
    return (
      <div style={{ color: '#335533', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>
        SELECT AIRCRAFT
      </div>
    );
  }

  const sendHdg = () => {
    const raw = hdg.trim().toLowerCase();
    let dir: 'left' | 'right' | undefined;
    let digits = raw;
    if (raw.startsWith('r')) { dir = 'right'; digits = raw.slice(1); }
    else if (raw.startsWith('l')) { dir = 'left';  digits = raw.slice(1); }
    const v = parseInt(digits, 10);
    if (v >= 1 && v <= 360) {
      onCommand(selected.id, { type: 'heading', value: v, turnDirection: dir });
      setHdg('');
    }
  };

  const sendAlt = () => {
    // Accept FL notation (FL100 = 10000) or raw feet
    let raw = alt.toUpperCase().replace('FL', '');
    let v = parseInt(raw, 10);
    if (alt.toUpperCase().startsWith('FL')) v = v * 100;
    if (v >= 0 && v <= 41000) {
      onCommand(selected.id, { type: 'altitude', value: v });
      setAlt('');
    }
  };

  const sendSpd = () => {
    const v = parseInt(spd, 10);
    if (v >= 80 && v <= 350) {
      onCommand(selected.id, { type: 'speed', value: v });
      setSpd('');
    }
  };

  // Alle ILS-Bahnen der aktiven Richtung (ohne aktive Auswahl: alle ILS-Bahnen)
  const ilsRunways = airport?.runways.filter((rwy) =>
    rwy.ils && (activeRunwayIds.length === 0 || activeRunwayIds.includes(rwy.id)),
  ) ?? [];
  const tower = airport ? stations(airport).tower : null;
  const towerPending = pendingCmdTypes.includes('tower');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ color: '#00ff88', fontWeight: 'bold', fontSize: 13, borderBottom: '1px solid #1a3a1a', paddingBottom: 6 }}>
        {selected.callsign} / {selected.type}
      </div>

      {/* Heading */}
      <div>
        <label style={LABEL_STYLE}>
          HEADING&nbsp;&nbsp;
          <span style={{ color: '#00ff88' }}>{String(Math.round(selected.headingDeg)).padStart(3, '0')}°</span>
          {Math.abs(selected.targetHeading - Math.round(selected.headingDeg)) > 1 && (
            <span style={{ color: '#ffaa00' }}> ({String(Math.round(selected.targetHeading)).padStart(3, '0')}°)</span>
          )}
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="text"
            value={hdg}
            onChange={(e) => setHdg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendHdg()}
            placeholder="090 · r090 · l090"
            style={{ ...INPUT_STYLE, flex: 1 }}
          />
          <button onClick={sendHdg} style={{ ...BTN_STYLE, width: 40, marginTop: 0 }}>HDG</button>
        </div>
      </div>

      {/* Altitude */}
      <div>
        <label style={LABEL_STYLE}>
          ALTITUDE&nbsp;&nbsp;
          <span style={{ color: '#00ff88' }}>FL{Math.round(selected.altitudeFt / 100).toString().padStart(3, '0')}</span>
          {Math.abs(selected.targetAltitude - selected.altitudeFt) > 50 && (
            <span style={{ color: '#ffaa00' }}> (FL{Math.round(selected.targetAltitude / 100).toString().padStart(3, '0')})</span>
          )}
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="text"
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendAlt()}
            placeholder={`FL${Math.round(selected.altitudeFt / 100).toString().padStart(3, '0')}`}
            style={{ ...INPUT_STYLE, flex: 1 }}
            inputMode="numeric"
          />
          <button onClick={sendAlt} style={{ ...BTN_STYLE, width: 40, marginTop: 0 }}>ALT</button>
        </div>
      </div>

      {/* Speed */}
      <div>
        <label style={LABEL_STYLE}>
          SPEED&nbsp;&nbsp;
          <span style={{ color: '#00ff88' }}>{Math.round(selected.speedKts)}kt</span>
          {Math.abs(selected.targetSpeed - selected.speedKts) > 2 && (
            <span style={{ color: '#ffaa00' }}> ({Math.round(selected.targetSpeed)}kt)</span>
          )}
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="number" min={80} max={350}
            value={spd}
            onChange={(e) => setSpd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendSpd()}
            placeholder={`${Math.round(selected.speedKts)}kt`}
            style={{ ...INPUT_STYLE, flex: 1 }}
            inputMode="numeric"
          />
          <button onClick={sendSpd} style={{ ...BTN_STYLE, width: 40, marginTop: 0 }}>SPD</button>
        </div>
      </div>

      {/* ILS clearance */}
      {ilsRunways.length > 0 && (
        <div>
          <label style={LABEL_STYLE}>RUNWAY / ILS</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {ilsRunways.map((rwy) => (
              <button
                key={rwy.id}
                onClick={() => onCommand(selected.id, { type: 'ils', runwayId: rwy.id })}
                style={{
                  ...BTN_STYLE,
                  background: selected.assignedRunway === rwy.id ? '#0a4030' : '#0d2a18',
                  borderColor: selected.assignedRunway === rwy.id ? '#00ff88' : '#1a6044',
                  color: selected.assignedRunway === rwy.id ? '#00ff88' : '#44aa66',
                  marginTop: 0,
                }}
              >
                {selected.assignedRunway === rwy.id ? '✓ ' : ''}ILS RWY {rwy.id}
                {selected.assignedRunway !== rwy.id && (
                  <span style={{ float: 'right', opacity: getILSStatusForRunway(selected, rwy).canIntercept ? 1 : 0.5 }}>
                    {Math.round(getILSStatusForRunway(selected, rwy).distanceToThresholdNM)} NM
                  </span>
                )}
              </button>
            ))}
            {/* Übergabe an den Turm, danach kommt die Landefreigabe vom Turm */}
            {selected.clearedILS && selected.assignedRunway && tower && (
              <button
                title={tower.name}
                onClick={() => !selected.tower && !towerPending && onCommand(selected.id, { type: 'tower' })}
                style={{
                  ...BTN_STYLE,
                  marginTop: 0,
                  borderColor: selected.tower ? '#00ff88' : towerPending ? '#ffaa00' : '#e8b84a',
                  color: selected.tower ? '#00ff88' : towerPending ? '#ffaa00' : '#e8b84a',
                  cursor: selected.tower || towerPending ? 'default' : 'pointer',
                }}
              >
                {selected.tower ? '✓ ON TOWER' : towerPending ? '⧖ CONTACT TOWER' : 'CONTACT TOWER'} {tower.freq ?? ''}
              </button>
            )}
            {selected.clearedILS && selected.assignedRunway && selected.tower && (
              <button
                onClick={() => !selected.clearedToLand && onCommand(selected.id, { type: 'land' })}
                style={{
                  ...BTN_STYLE,
                  marginTop: 0,
                  borderColor: selected.clearedToLand ? '#00ff88' : '#ffcc44',
                  color: selected.clearedToLand ? '#00ff88' : '#ffcc44',
                  cursor: selected.clearedToLand ? 'default' : 'pointer',
                }}
              >
                {selected.clearedToLand ? '✓ ' : ''}CLEARED TO LAND RWY {selected.assignedRunway}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
