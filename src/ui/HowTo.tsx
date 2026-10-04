// filepath: src/ui/HowTo.tsx
// ATC-HowTo: was ein Lotse in welcher Flugphase tut, mit den Befehlen des Spiels und Funk-Beispielen
import { useEffect, useState, type ReactNode } from 'react';
import { NATO } from '@/game/Speech';

const FONT = '"Courier New", monospace';
const C = {
  head: '#00ff88', text: '#b8d8c0', dim: '#5a8a68', line: '#1a4428',
  atc: '#a8d8ff', atcTag: '#55bbff', twr: '#f4dca0', twrTag: '#e8b84a', pilot: '#b8e8c8', pilotTag: '#00cc66',
};
const SENDER_COLORS = {
  APP: [C.atcTag, C.atc], TWR: [C.twrTag, C.twr], PILOT: [C.pilotTag, C.pilot],
} as const;

const TABS = ['Überblick', 'Anflug', 'Befehle', 'Sprechfunk', 'Staffelung', 'Bedienung', 'Quellen'] as const;
type Tab = typeof TABS[number];

const H = ({ children }: { children: ReactNode }) => (
  <div style={{ color: C.head, fontWeight: 'bold', fontSize: 13, letterSpacing: 1, margin: '14px 0 6px' }}>{children}</div>
);
const P = ({ children }: { children: ReactNode }) => <p style={{ margin: '0 0 8px' }}>{children}</p>;
const B = ({ children }: { children: ReactNode }) => <b style={{ color: C.head, fontWeight: 'normal' }}>{children}</b>;

/** Funk-Beispiel wie im Funk-Log: Approach blau, Turm gelb, Pilot grün */
function Radio({ lines }: { lines: Array<[keyof typeof SENDER_COLORS, string]> }) {
  return (
    <div style={{ background: '#030a05', border: `1px solid ${C.line}`, borderRadius: 3, padding: '5px 8px', margin: '6px 0 8px', fontSize: 11 }}>
      {lines.map(([who, text], i) => (
        <div key={i} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: SENDER_COLORS[who][0], width: 42, flexShrink: 0, fontWeight: 'bold' }}>{who}</span>
          <span style={{ color: SENDER_COLORS[who][1] }}>{text}</span>
        </div>
      ))}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  const cell: React.CSSProperties = { borderBottom: `1px solid ${C.line}`, padding: '4px 6px', verticalAlign: 'top', textAlign: 'left' };
  return (
    <div style={{ overflowX: 'auto', margin: '6px 0 10px' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
        <thead>
          <tr>{head.map((h) => <th key={h} style={{ ...cell, color: C.dim, fontWeight: 'normal', letterSpacing: 1 }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={cell}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

function Phase({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ borderLeft: `2px solid ${C.line}`, paddingLeft: 10, margin: '10px 0 14px' }}>
      <div style={{ color: C.head, fontWeight: 'bold', marginBottom: 4 }}>{n}. {title}</div>
      {children}
    </div>
  );
}

function Overview() {
  return (
    <>
      <H>WER MACHT WAS</H>
      <P>Ein Flug geht durch mehrere Lotsen-Stellen. Jede hat ihre eigene Frequenz und gibt den Flieger an die nächste weiter.</P>
      <Table
        head={['STELLE', 'AUFGABE']}
        rows={[
          ['Delivery', 'Streckenfreigabe vor dem Start (Route, SID, Transpondercode)'],
          ['Ground', 'Rollen zwischen Parkposition und Bahn'],
          ['Tower', 'Start- und Landefreigaben, alles auf und direkt über der Bahn'],
          ['Departure', 'Steigflug nach dem Start, Übergabe an die Strecke'],
          ['Center', 'Reiseflug auf der Strecke, Sinkflug bis in den Anflugbereich'],
          [<B key="a">Approach</B>, 'Anflug: von der STAR per Radarführung auf das ILS, Abstände auf dem Endanflug'],
        ]}
      />
      <H>DEINE ROLLE IM SPIEL</H>
      <P>Du bist <B>Approach und Tower</B> zugleich. Die Flieger kommen auf ihrer STAR in deinen Bereich und melden sich bei dir. Deine Aufgabe: sie sicher gestaffelt hintereinander auf den Endanflug bringen, das ILS freigeben und die Landung freigeben.</P>
      <P>Wie in echt kannst du den Flieger nach der ILS-Freigabe an den Turm übergeben (CONTACT TOWER). Er wechselt auf die Turmfrequenz und meldet sich dort; die Landefreigabe kommt dann mit der Stimme des Turms. Die Übergabe ist freiwillig und bringt keine Punkte.</P>
      <P>Gut gemacht ist es, wenn keiner durchstarten muss und sich nie zwei Flieger zu nahe kommen.</P>
      <H>ECHTER VERKEHR (LIVE)</H>
      <P>Mit <B>TRAFFIC LIVE</B> zeigt das Radar statt des erfundenen Verkehrs die echten Flieger rund um den Platz, grau und mit Spur.</P>
      <P><span style={{ color: '#78d7ff' }}>Hellblau</span> sind die echten Anflüge auf deinen Platz, mit ihrem Startplatz neben dem Rufzeichen (ohne bekannte Route steht dort ein „?“). Zwischen 60 und 25 NM vor dem Platz meldet sich der Pilot bei dir, mit der Höhe, die ihm der echte Lotse zuletzt freigegeben hat; bis du ihn übernimmst, blinkt er.</P>
      <P><B>Übernehmen:</B> Klick auf den hellblauen Flieger oder auf seinen Anruf im Funk-Log. Er wird zu deinem Flieger und hört ab jetzt auf dich: Er folgt der nächstgelegenen STAR deiner aktiven Bahn; ist er schon auf dem Endanflug, behält er seine ILS-Freigabe. Sein echtes Gegenstück verschwindet vom Radar. Hat er sich noch nicht gemeldet, ruft er gleich an.</P>
      <P>Punkte gibt es nur für Landungen übernommener Flieger. Zu den echten Fliegern hältst du denselben Abstand wie zu deinen eigenen; nach der ILS-Freigabe zählt das innerhalb von 15 NM um den Platz nicht mehr, dort ist der echte Tower zuständig. LIVE läuft in Echtzeit, ohne Zeitraffer.</P>
      <P>Die Landerichtung folgt bei LIVE den echten Landungen: Sind in 10 Minuten mindestens zwei echte Flieger in der anderen Richtung gelandet und keiner in deiner, stellt das Spiel um.</P>
      <H>WETTER UND LANDERICHTUNG</H>
      <P>Das Spiel holt alle 10 Minuten das aktuelle Wetter des Platzes (METAR). Daraus kommen das QNH im Funk (in den USA „altimeter“ in inHg) und der Bodenwind in der Landefreigabe.</P>
      <P>Gelandet wird gegen den Wind. Steht <B>ACTIVE RWY</B> auf AUTO, wählt das Spiel die Richtung mit dem meisten Gegenwind (AUTO · WIND), bei LIVE die der echten Landungen (AUTO · LIVE). Ein Wechsel steht im Funk-Log. Schaltest du von Hand um, bleibt es dabei (MANUELL), bis du auf MANUELL klickst.</P>
    </>
  );
}

function Approach() {
  return (
    <>
      <P>So läuft ein Anflug ab, von der Meldung bis zur Landung. Die Funksprüche sind Beispiele aus dem Spiel.</P>
      <Phase n={1} title="Erstanruf">
        <P>Der Pilot meldet sich mit Höhe, STAR und dem Buchstaben der Wetterinformation (ATIS). Mit deinem ersten Befehl bestätigst du den Radarkontakt; das sagt das Spiel automatisch dazu.</P>
        <Radio lines={[
          ['PILOT', 'Frankfurt Arrival, Lufthansa 427, FL120 descending FL100, KERAX 6A arrival, information Delta'],
          ['APP', 'Lufthansa 427, radar contact, descend FL080'],
          ['PILOT', 'Descend FL080, Lufthansa 427'],
        ]} />
      </Phase>
      <Phase n={2} title="Anflugstrecke (STAR)">
        <P>Der Flieger folgt der STAR mit ihren Höhen- und Geschwindigkeitsvorgaben. Du gibst den Sinkflug frei, kürzt per Direct-to ab oder weist eine andere STAR zu. Unter FL100 sind höchstens 250 kt üblich.</P>
        <P>Welche STAR ein Flieger fliegt, ergibt sich wie in echt aus seinem Einflugpunkt (der Richtung, aus der er kommt; Startplatz im Flugstreifen) und der Landerichtung. Wechselt die Landerichtung, weist das Spiel den Fliegern auf einer STAR die passende neue STAR zu.</P>
        <P>Unterhalb der <B>Übergangshöhe</B> (in Deutschland meist 5000 ft) gibt es keine Flugflächen mehr, sondern Höhen über dem Meer. Mit der ersten Höhe darunter nennst du das QNH (Luftdruck).</P>
        <Radio lines={[
          ['APP', 'Lufthansa 427, proceed direct KERAX, then KERAX 6A arrival, expect runway 25R'],
          ['APP', 'Lufthansa 427, descend 5000 ft, QNH 1014'],
        ]} />
      </Phase>
      <Phase n={3} title="Radarführung (Vektoren)">
        <P>Für die Reihenfolge auf dem Endanflug führst du die Flieger mit Kursen: Gegenanflug parallel zur Bahn, dann Queranflug, dann Eindrehen. Ziel ist ein Abfangkurs von höchstens 30° zum Endanflug, etwa 10 bis 15 NM vor der Schwelle, auf 3000 bis 4000 ft.</P>
        <P>Mit der Geschwindigkeit regelst du die Abstände: Gegenanflug etwa 220 kt, Queranflug 180 kt, Endanflug 160 kt.</P>
        <Radio lines={[
          ['APP', 'Lufthansa 427, turn left heading 160'],
          ['APP', 'Lufthansa 427, reduce speed 180 kt'],
        ]} />
      </Phase>
      <Phase n={4} title="ILS-Freigabe">
        <P>Liegt der Flieger auf dem Abfangkurs, gibst du das ILS frei. Er fängt den Localizer (Streifen <B>INT</B>), dann den Gleitpfad (<B>EST</B>) und sinkt selbstständig.</P>
        <Radio lines={[
          ['APP', 'Lufthansa 427, cleared ILS approach runway 25R'],
          ['PILOT', 'Cleared ILS approach runway 25R, Lufthansa 427'],
          ['PILOT', 'Lufthansa 427, established ILS runway 25R'],
        ]} />
        <P>Danach übergibst du ihn an den Turm. Der Pilot liest die Frequenz zurück, wechselt und meldet sich dort.</P>
        <Radio lines={[
          ['APP', 'Lufthansa 427, contact Frankfurt Tower 118.780'],
          ['PILOT', 'Tower 118.780, Lufthansa 427'],
          ['PILOT', 'Frankfurt Tower, Lufthansa 427, established ILS runway 25R'],
        ]} />
      </Phase>
      <Phase n={5} title="Endanflug und Landefreigabe">
        <P>Auf dem Endanflug hältst du mindestens 3 NM Abstand zum Vordermann (2,5 NM ab 10 NM vor der Schwelle), hinter Heavy und Super mehr wegen der Wirbelschleppen. Die Landefreigabe gibt nur der Turm: erst nach CONTACT TOWER, sobald die Bahn frei ist, mit dem aktuellen Bodenwind. Fehlt sie, erinnert der Pilot 4 NM vor der Schwelle daran; bei 1 NM startet er durch.</P>
        <Radio lines={[
          ['PILOT', 'Lufthansa 427, 4 miles final runway 25R'],
          ['TWR', 'Lufthansa 427, wind 250° 8 kt, runway 25R, cleared to land'],
          ['PILOT', 'Cleared to land runway 25R, Lufthansa 427'],
        ]} />
      </Phase>
      <Phase n={6} title="Durchstarten">
        <P>Der Flieger fliegt geradeaus weiter und steigt auf 4000 ft. Seine Freigaben sind weg, und er ist wieder bei Approach: du reihst ihn mit Kursen neu ein und gibst das ILS noch einmal frei.</P>
        <Radio lines={[['PILOT', 'Lufthansa 427, going around'], ['APP', 'Lufthansa 427, turn right heading 340, climb 4000 ft']]} />
      </Phase>
      <P>In echt übergibt der Tower nach der Landung an Ground. Im Spiel endet der Flug mit dem Aufsetzen.</P>
    </>
  );
}

function Commands() {
  return (
    <>
      <P>Befehle gibst du rechts im Feld COMMANDS oder per Rechtsklick auf den Flieger (Kontextmenü). Der Pilot reagiert nach 1 bis 3 Sekunden.</P>
      <Table
        head={['BEFEHL', 'EINGABE', 'FUNK']}
        rows={[
          ['Kurs', <>HDG: <B>270</B>; <B>r090</B> oder <B>l090</B> erzwingt die Drehrichtung; im Menü L30, L90, R90, R30</>, 'turn left heading 270'],
          ['Höhe', <>ALT: <B>FL80</B> oder <B>4000</B> (Fuß)</>, 'descend FL080 / descend 4000 ft, QNH 1014'],
          ['Geschwindigkeit', <>SPD: <B>180</B></>, 'reduce speed 180 kt'],
          ['Direct-to', 'Menü DIRECT TO, Wegpunkt antippen oder eintippen', 'proceed direct KERAX'],
          ['Anflugpunkt und STAR', 'Menü ENTRY → STAR: Punkt wählen, dann STAR und Bahn', 'proceed direct KERAX, then KERAX 6A arrival, expect runway 25R'],
          ['ILS', 'Knopf ILS RWY oder Menü RUNWAY / ILS', 'cleared ILS approach runway 25R'],
          ['Übergabe an den Turm', 'Knopf CONTACT TOWER oder Menü, erscheint nach der ILS-Freigabe', 'contact Frankfurt Tower 118.780'],
          ['Landefreigabe', 'Knopf CLEARED TO LAND, erscheint nach der Übergabe an den Turm', 'wind 250° 8 kt, runway 25R, cleared to land'],
        ]}
      />
      <H>STATUS AUF DEM STREIFEN</H>
      <Table
        head={['KÜRZEL', 'BEDEUTUNG']}
        rows={[
          ['ENR', 'fliegt die STAR oder geradeaus'],
          ['VCT', 'wird mit Kursen geführt'],
          ['INT', 'fängt den Localizer'],
          ['EST', 'auf dem ILS, sinkt auf dem Gleitpfad'],
          ['G/A', 'startet durch'],
          ['TWR', 'an den Turm übergeben'],
        ]}
      />
    </>
  );
}

function Phraseology() {
  return (
    <>
      <H>GRUNDREGELN</H>
      <P><B>Wer, an wen:</B> Der Lotse beginnt mit dem Rufzeichen des Fliegers. Der Pilot liest zurück und hängt sein Rufzeichen ans Ende.</P>
      <P><B>Rücklesen:</B> Höhen, Kurse, Geschwindigkeiten, Bahn und Freigaben muss der Pilot wiederholen. So fallen Hörfehler auf.</P>
      <P><B>Rufzeichen:</B> Gesprochen wird der Funkname der Airline, nicht das Kürzel: DLH ist Lufthansa, BAW ist Speedbird, EZY ist Easy, CFG ist Condor.</P>
      <P><B>Zahlen:</B> Ziffern einzeln, mit den Funk-Aussprachen tree (3), fife (5) und niner (9). Kurs 090 ist „heading zero niner zero“.</P>
      <P><B>Höhen:</B> Über der Übergangshöhe Flugflächen („flight level eight zero“, volle Hunderter als „flight level one hundred“), darunter Fuß mit QNH („altitude four thousand feet“).</P>
      <P><B>ATIS:</B> Die Wetter- und Platzinformation trägt einen Buchstaben. Der Pilot nennt ihn beim Erstanruf, damit klar ist, dass er das aktuelle Wetter kennt.</P>
      <P><B>Rufnamen und Frequenzen:</B> Jede Stelle hat ihren eigenen Rufnamen, oft nicht nach der Stadt: in Frankfurt etwa „Frankfurt Arrival“ für den Anflug, in London „Heathrow Director“. Das Spiel nimmt sie mit den Frequenzen aus den Platzdaten (rechts unter FREQ / WX).</P>
      <P><B>Frequenzen:</B> Gesprochen mit „decimal“ und allen sechs Ziffern, nur zwei Nullen am Ende entfallen: 118.780 ist „one one eight decimal seven eight zero“, 118.100 ist „one one eight decimal one“.</P>
      <P><B>Wind:</B> Der Turm nennt ihn mit der Landefreigabe, missweisend und auf 10° gerundet: „wind two five zero degrees eight knots“.</P>
      <H>BUCHSTABIERALPHABET</H>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '2px 10px', fontSize: 11 }}>
        {Object.entries(NATO).map(([letter, word]) => (
          <span key={letter}><B>{letter}</B> {word}</span>
        ))}
      </div>
    </>
  );
}

function Separation() {
  return (
    <>
      <H>MINDESTABSTÄNDE</H>
      <Table
        head={['FALL', 'GRENZE', 'ANZEIGE']}
        rows={[
          ['Staffelung unterschritten', 'unter 3 NM seitlich und unter 1000 ft Höhe', 'rot'],
          ['Warnung', 'unter 5 NM seitlich und unter 2000 ft Höhe', 'gelb'],
          ['Endanflug, gleiche Bahn', 'Wirbelschleppen-Abstand zum Vordermann, mindestens 3 NM (2,5 NM innerhalb 10 NM vor der Schwelle); Höhe zählt nicht', 'rot darunter, gelb bis 1 NM darüber'],
          ['Endanflug, Parallelbahnen', 'beide auf ihrem Localizer: keine Staffelung nötig', '—'],
        ]}
      />
      <P>Es reicht, wenn einer der beiden Abstände eingehalten ist: Zwei Flieger übereinander mit 1000 ft Unterschied sind gestaffelt.</P>
      <P>Bei LIVE gilt das auch gegenüber den echten Fliegern, außer im Endanflug: Hat dein Flieger die ILS-Freigabe, zählen echte Flieger innerhalb von 15 NM um den Platz nicht mehr.</P>
      <P><B>Wirbelschleppen im Endanflug (ICAO):</B> Heavy hinter Heavy 4 NM, Medium hinter Heavy 5 NM, Heavy hinter Super (A380) 6 NM, Medium hinter Super 7 NM. Die Klasse steht auf dem Streifen (H, J).</P>
      <H>PUNKTE</H>
      <Table
        head={['EREIGNIS', 'PUNKTE']}
        rows={[
          ['Landung', '+100'],
          ['Durchstarten', '−30'],
          ['Staffelung unterschritten (je Paar, höchstens alle 10 s)', '−200'],
        ]}
      />
      <H>TIPPS</H>
      <P>Früh sortieren: Lege die Reihenfolge fest, solange die Flieger noch weit weg sind, und staffle sie in der Höhe.</P>
      <P>Geschwindigkeit ist dein feinstes Werkzeug: 20 kt weniger beim Hintermann schaffen über die Zeit viel Abstand.</P>
      <P>Gib das ILS erst frei, wenn der Kurs passt. Wer zu steil auf den Localizer zufliegt, schießt durch.</P>
    </>
  );
}

function Controls() {
  return (
    <Table
      head={['AKTION', 'SO GEHT ES']}
      rows={[
        ['Flieger wählen', 'Klick auf den Flieger, den Streifen oder eine Zeile im Funk-Log'],
        ['Kontextmenü', 'Rechtsklick auf den Flieger (am Handy lange tippen)'],
        ['Karte verschieben', 'Ziehen mit der Maus oder dem Finger'],
        ['Zoomen', 'Mausrad, RANGE oder zwei Finger auseinander/zusammen'],
        ['3D-Ansicht', '3D unten rechts schaltet um. Ziehen verschiebt, rechte Maustaste oder Shift+Ziehen dreht und neigt, Mausrad zoomt. Am Handy: zwei Finger drehen, zoomen und (gemeinsam hoch/runter) neigen. Die Knöpfe unten rechts tun dasselbe, ⌂ setzt zurück. Höhen sind vierfach überhöht.'],
        ['Verkehr', 'TRAFFIC: SIM ist erfundener Verkehr zum Lotsen, LIVE zeigt die echten Flieger (Beschriftung unter FL200, Anflüge hellblau). Die Anzeige nennt alle Flieger (AC) und die Anflüge (IN).'],
        ['Echten Anflug übernehmen', 'LIVE: Klick oder Rechtsklick auf einen hellblauen Flieger, oder Klick auf seinen Anruf im Funk-Log'],
        ['Landerichtung', 'ACTIVE RWY: AUTO bleibt wie in echt bei der Vorzugsrichtung (West, z. B. Frankfurt 25), bis der Rückenwind mehr als 5 kt beträgt; bei LIVE gilt die Richtung der echten Landungen. Bahnen der Gegenrichtung schalten von Hand um (MANUELL), ein Klick auf MANUELL wieder auf AUTO.'],
        ['Funkstellen und Wetter', 'FREQ / WX: Approach und Turm mit Frequenz, Wind und QNH. Die Maus über WX zeigt das METAR.'],
        ['Zeitraffer', 'SESSION 1x bis 8x (bei LIVE nur 1x), Pause mit ⏸'],
        ['Anzeige', 'Unten LABELS, ILS, NAVAID, STARs. NAVAID zeigt Funkfeuer und die Punkte der STARs aktiver Bahnen; NAV ALL zeigt zusätzlich die Punkte inaktiver Bahnen.'],
        ['Funk', 'RADIO zeigt das Funk-Log, VOICE schaltet die Stimmen. Ton gibt es erst nach dem ersten Klick ins Spiel.'],
      ]}
    />
  );
}

function Credits() {
  const link = (href: string, label: string) => <a href={href} target="_blank" rel="noreferrer" style={{ color: C.atc }}>{label}</a>;
  return (
    <>
      <H>DATEN</H>
      <P>Flughäfen, Bahnen und Funkfeuer: {link('https://ourairports.com/data/', 'OurAirports')} (gemeinfrei).</P>
      <P>Anflugverfahren (STARs), ILS und Funkfrequenzen: Navigraph AIRAC, nur zur privaten Nutzung freigeschaltet. Sonst Funkfrequenzen von {link('https://ourairports.com/data/', 'OurAirports')} (gemeinfrei).</P>
      <P>Wetter (METAR): {link('https://aviationweather.gov/data/api/', 'aviationweather.gov')} (NOAA/NWS, gemeinfrei).</P>
      <P>Funknamen der Airlines: {link('https://openflights.org/data.php', 'OpenFlights')}, Open Database License (ODbL).</P>
      <P>Echter Verkehr (LIVE): {link('https://adsb.lol', 'adsb.lol')}, Open Database License (ODbL).</P>
      <P>Start und Ziel der echten Flüge: Routen-Abfrage von adsb.lol (adsb.im), Routendaten aus {link('https://github.com/vradarserver/standing-data', 'VRS standing-data')} (CC0).</P>
      <H>STIMMEN</H>
      <P>Sprachausgabe mit {link('https://github.com/OHF-Voice/piper1-gpl', 'Piper')} (GPL-3.0), als eigener Dienst auf dem Server.</P>
      <P>Approach: Stimme „joe“ (CC0). Turm und Piloten: Stimmen aus {link('https://www.openslr.org/141/', 'LibriTTS-R')} (Koizumi et al., CC BY 4.0) und dem {link('https://datashare.ed.ac.uk/handle/10283/3443', 'CSTR VCTK Corpus')} (University of Edinburgh, CC BY 4.0).</P>
    </>
  );
}

const CONTENT: Record<Tab, () => JSX.Element> = {
  Überblick: Overview, Anflug: Approach, Befehle: Commands, Sprechfunk: Phraseology,
  Staffelung: Separation, Bedienung: Controls, Quellen: Credits,
};

export function HowTo({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('Überblick');
  const Content = CONTENT[tab];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
    >
      <div
        role="dialog"
        aria-label="ATC HowTo"
        onClick={(e) => e.stopPropagation()}
        style={{
          // Feste Höhe: die Reiter springen beim Wechsel nicht
          width: 'min(780px, 100%)', height: 'min(860px, 100%)', display: 'flex', flexDirection: 'column',
          background: '#070f0a', border: '1px solid #1a5530', borderRadius: 4,
          fontFamily: FONT, fontSize: 12, lineHeight: '17px', color: C.text, boxShadow: '0 4px 30px rgba(0,0,0,0.9)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${C.line}` }}>
          <span style={{ color: C.head, fontWeight: 'bold', letterSpacing: 2 }}>ATC HOWTO</span>
          <button onClick={onClose} title="Schließen (Esc)"
            style={{ background: 'transparent', border: `1px solid ${C.line}`, color: C.dim, fontFamily: FONT, cursor: 'pointer', borderRadius: 2, padding: '1px 8px' }}>
            ✕
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '8px 12px 0' }}>
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                background: tab === t ? '#0a3020' : 'transparent',
                border: `1px solid ${tab === t ? '#00cc66' : C.line}`,
                color: tab === t ? C.head : C.dim,
                fontFamily: FONT, fontSize: 11, padding: '3px 8px', cursor: 'pointer', borderRadius: 2,
              }}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ overflowY: 'auto', padding: '4px 14px 14px' }}>
          <Content />
        </div>
      </div>
    </div>
  );
}
