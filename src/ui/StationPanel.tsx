// filepath: src/ui/StationPanel.tsx
import type { Airport } from '@/types/airport';
import type { Weather } from '@/types/weather';
import { stations } from '@/game/Phraseology';
import { pad3 } from '@/game/Speech';

interface Props {
  airport: Airport;
  weather: Weather | null;
}

/** Wind wie im METAR (rechtweisend): "250° 12 kt G22", "VRB 2 kt", "CALM" */
function windText(w: Weather): string {
  if (w.windKt < 1) return 'CALM';
  const dir = w.windDir === null ? 'VRB' : `${pad3(w.windDir)}°`;
  return `${dir} ${Math.round(w.windKt)} kt${w.gustKt ? ` G${Math.round(w.gustKt)}` : ''}`;
}

function pressureText(w: Weather): string {
  if (w.altimeterInHg !== null) return `ALT ${w.altimeterInHg.toFixed(2)}`;
  return w.qnh !== null ? `QNH ${w.qnh}` : '';
}

function Row({ label, name, value, title }: { label: string; name: string; value: string; title?: string }) {
  return (
    <div title={title} style={{ display: 'flex', gap: 6, fontSize: 11, lineHeight: '16px' }}>
      <span style={{ color: '#446644', width: 28, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#88bb99', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{ color: '#00ff88', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

/** Funkstellen des Platzes mit Frequenz und das Wetter aus dem METAR */
export function StationPanel({ airport, weather }: Props) {
  const { approach, tower } = stations(airport);
  return (
    <div>
      <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>FREQ / WX</div>
      <Row label="APP" name={approach.name} value={approach.freq ?? '—'} title="Anflugkontrolle (du)" />
      <Row label="TWR" name={tower.name} value={tower.freq ?? '—'} title="Turm (auch du): Übergabe nach der ILS-Freigabe" />
      {weather
        ? <Row label="WX" name={windText(weather)} value={pressureText(weather)} title={weather.raw} />
        : <Row label="WX" name="—" value="" title="Kein METAR für diesen Platz" />}
    </div>
  );
}
