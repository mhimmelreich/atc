// filepath: src/ui/ScorePanel.tsx
const TIME_SCALES = [1, 2, 4, 8] as const;

interface Props {
  score: number;
  landings: number;
  violations: number;
  paused: boolean;
  timeScale: number;
  /** LIVE: nur Echtzeit */
  timeLocked?: boolean;
  sweepEnabled: boolean;
  onPause: () => void;
  onResume: () => void;
  onToggleSweep: () => void;
  onTimeScale: (s: number) => void;
}

export function ScorePanel({ score, landings, violations, paused, timeScale, timeLocked, sweepEnabled, onPause, onResume, onToggleSweep, onTimeScale }: Props) {
  return (
    <div style={{ borderTop: '1px solid #1a3a1a', paddingTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 4 }}>
        <span style={{ color: '#446644', fontSize: 10, letterSpacing: 1 }}>SESSION</span>
        <button
          onClick={onToggleSweep}
          style={{
            background: sweepEnabled ? '#0a2a18' : 'transparent',
            border: '1px solid #335533',
            color: sweepEnabled ? '#00cc66' : '#446644',
            padding: '2px 6px',
            fontFamily: '"Courier New", monospace',
            fontSize: 10,
            cursor: 'pointer',
            borderRadius: 2,
          }}
        >
          SWEEP
        </button>
        <button
          onClick={paused ? onResume : onPause}
          style={{
            background: 'transparent',
            border: '1px solid #335533',
            color: '#446644',
            padding: '2px 8px',
            fontFamily: '"Courier New", monospace',
            fontSize: 11,
            cursor: 'pointer',
            borderRadius: 2,
          }}
        >
          {paused ? '▶' : '⏸'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
        {TIME_SCALES.map((s) => (
          <button
            key={s}
            onClick={() => onTimeScale(s)}
            disabled={timeLocked && s !== 1}
            title={timeLocked && s !== 1 ? 'LIVE läuft in Echtzeit' : undefined}
            style={{
              flex: 1,
              background: timeScale === s ? '#0a3020' : 'transparent',
              border: `1px solid ${timeScale === s ? '#00cc66' : '#335533'}`,
              color: timeScale === s ? '#00ff88' : '#446644',
              fontFamily: '"Courier New", monospace',
              fontSize: 10,
              padding: '3px 0',
              cursor: timeLocked && s !== 1 ? 'not-allowed' : 'pointer',
              opacity: timeLocked && s !== 1 ? 0.35 : 1,
              borderRadius: 2,
            }}
          >
            {s}x
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
        <Stat label="SCORE" value={score.toString()} color={score >= 0 ? '#00ff88' : '#ff3333'} />
        <Stat label="LANDED" value={landings.toString()} color="#00ff88" />
        <Stat label="VIOL." value={violations.toString()} color={violations > 0 ? '#ff3333' : '#446644'} />
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ color: '#335533', fontSize: 9, letterSpacing: 1 }}>{label}</div>
      <div style={{ color, fontSize: 16, fontWeight: 'bold' }}>{value}</div>
    </div>
  );
}
