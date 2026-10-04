// filepath: src/ui/AlertBanner.tsx
import { useEffect, useState } from 'react';
import type { ConflictPair } from '@/types/aircraft';
import type { Aircraft } from '@/types/aircraft';

interface Alert {
  id: string;
  message: string;
  type: 'warning' | 'conflict';
  ts: number;
}

interface Props {
  conflicts: ConflictPair[];
  aircraft: Aircraft[];
  /** Rufzeichen echter Flieger (LIVE) nach Kennung */
  names?: Record<string, string>;
}

export function AlertBanner({ conflicts, aircraft, names }: Props) {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const now = Date.now();
    const newAlerts: Alert[] = conflicts.map((c) => {
      const a = aircraft.find((ac) => ac.id === c.a);
      const b = aircraft.find((ac) => ac.id === c.b);
      const csA = a?.callsign ?? names?.[c.a] ?? c.a;
      const csB = b?.callsign ?? names?.[c.b] ?? c.b;
      const sep = `${c.lateralNM.toFixed(1)}NM / ${Math.round(c.verticalFt)}ft`;
      return {
        id: `${c.a}:${c.b}`,
        message: c.type === 'conflict'
          ? `SEPARATION VIOLATION: ${csA} ↔ ${csB} (${sep})`
          : `TRAFFIC ALERT: ${csA} ↔ ${csB} (${sep})`,
        type: c.type,
        ts: now,
      };
    });

    setAlerts(newAlerts);
  }, [conflicts, aircraft, names]);

  if (alerts.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {alerts.map((alert) => (
        <div
          key={alert.id}
          style={{
            background: alert.type === 'conflict' ? 'rgba(255,50,50,0.15)' : 'rgba(255,170,0,0.12)',
            border: `1px solid ${alert.type === 'conflict' ? '#ff3333' : '#ffaa00'}`,
            color: alert.type === 'conflict' ? '#ff3333' : '#ffaa00',
            padding: '5px 8px',
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 0.5,
            borderRadius: 3,
            animation: 'blink 1s step-start infinite',
          }}
        >
          {alert.message}
        </div>
      ))}
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
