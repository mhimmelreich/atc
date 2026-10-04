// filepath: src/services/RadioVoice.ts
// Sprachausgabe des Funkverkehrs: Stimmen vom Sprachdienst (Piper), Funkklang per WebAudio.
// Ohne Sprachdienst spricht die Browser-Sprachausgabe (ohne Funkklang).
import type { RadioMessage } from '@/types/radio';

const MAX_QUEUE = 6;      // ein Kanal: bei Stau die ältesten Meldungen verwerfen
const STALE_MS = 25_000;  // so alte Meldungen nicht mehr abspielen
const GAP_MS = 350;       // Pause zwischen zwei Sprechern
const PREFETCH = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function biquad(ctx: AudioContext, type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  return f;
}

/** Weiche Übersteuerung wie bei einem Funkgerät */
function driveCurve(amount: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i * 2) / curve.length - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

export class RadioVoice {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private clicks = new Map<number, AudioBuffer>();
  private queue: RadioMessage[] = [];
  private buffers = new Map<number, Promise<AudioBuffer | null>>();
  private playing = false;
  private enabled = false;
  private stopCurrent: (() => void) | null = null;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.unlock();
    else this.clear();
  }

  /** Aus einer Nutzeraktion aufrufen: Browser geben Ton erst danach frei */
  unlock(): void {
    // Vor der ersten Nutzeraktion würde der Browser den Audio-Kontext ohnehin blockieren
    if (!this.enabled || navigator.userActivation?.hasBeenActive === false) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch { /* kein WebAudio: Browser-Sprachausgabe */ }
  }

  clear(): void {
    this.queue = [];
    this.buffers.clear();
    this.stopCurrent?.();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  enqueue(msg: RadioMessage): void {
    // Hinweise des Spiels stehen nur im Log
    if (!this.enabled || msg.from === 'info') return;
    this.queue.push(msg);
    while (this.queue.length > MAX_QUEUE) this.buffers.delete(this.queue.shift()!.id);
    this.prefetch();
    void this.pump();
  }

  private running(): AudioContext | null {
    return this.ctx?.state === 'running' ? this.ctx : null;
  }

  // Die nächsten Meldungen schon laden, während noch gesprochen wird
  private prefetch(): void {
    const ctx = this.running();
    if (ctx) for (const m of this.queue.slice(0, PREFETCH)) void this.load(ctx, m);
  }

  private load(ctx: AudioContext, msg: RadioMessage): Promise<AudioBuffer | null> {
    let buffer = this.buffers.get(msg.id);
    if (!buffer) {
      const url = `${import.meta.env.BASE_URL}api/tts?voice=${msg.voice}&speaker=${msg.speaker}&text=${encodeURIComponent(msg.spoken)}`;
      buffer = fetch(url)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`TTS ${res.status}`))))
        .then((data) => ctx.decodeAudioData(data))
        .catch(() => null);
      this.buffers.set(msg.id, buffer);
    }
    return buffer;
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    const msg = this.queue.shift();
    if (!msg) return;
    this.playing = true;
    try {
      // Zu alt, oder noch keine Freigabe durch eine Nutzeraktion: Meldung fällt weg
      const ctx = this.running();
      if (!ctx || Date.now() - msg.ts > STALE_MS) return;
      const buffer = await this.load(ctx, msg);
      this.buffers.delete(msg.id);
      if (!this.enabled) return;
      // Sprachdienst nicht erreichbar: Browser-Sprachausgabe
      if (buffer) await this.playRadio(ctx, buffer, msg.from === 'pilot');
      else await this.speakFallback(msg);
      await sleep(GAP_MS);
    } finally {
      this.playing = false;
      this.prefetch();
      void this.pump();
    }
  }

  private playRadio(ctx: AudioContext, buffer: AudioBuffer, pilot: boolean): Promise<void> {
    const t0 = ctx.currentTime + 0.06;
    // Piper hängt Stille an; die Sendetaste geht kurz nach dem letzten Wort los
    const end = t0 + speechEnd(buffer) + 0.08;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(ctx.destination);

    // Sprache im Funkband, Piloten (Cockpit) etwas dumpfer und kräftiger übersteuert
    const voice = ctx.createBufferSource();
    voice.buffer = buffer;
    const drive = ctx.createWaveShaper();
    drive.curve = driveCurve(pilot ? 3.5 : 1.8);
    const level = ctx.createGain();
    level.gain.value = pilot ? 0.75 : 0.85;
    voice
      .connect(biquad(ctx, 'highpass', 320, 0.7))
      .connect(drive)
      .connect(biquad(ctx, 'lowpass', pilot ? 2600 : 3200, 0.7))
      .connect(level)
      .connect(out);

    // Rauschen während der Sendung, endet mit dem Loslassen der Sendetaste
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx);
    noise.loop = true;
    const hiss = ctx.createGain();
    const n = pilot ? 0.04 : 0.02;
    hiss.gain.setValueAtTime(0, t0 - 0.05);
    hiss.gain.linearRampToValueAtTime(n, t0);
    hiss.gain.setValueAtTime(0, end + 0.004);
    noise
      .connect(biquad(ctx, 'highpass', 500, 0.7))
      .connect(biquad(ctx, 'lowpass', 2400, 0.7))
      .connect(hiss)
      .connect(out);

    // Mechanische Sendetaste: leiser Klick beim Drücken, "klick-klack" beim Loslassen
    this.click(ctx, out, t0 - 0.05, 2800, 0.25);
    this.click(ctx, out, end, 2800, 0.6);
    this.click(ctx, out, end + 0.035, 1700, 0.45);

    noise.start(t0 - 0.05);
    voice.start(t0);
    noise.stop(end + 0.1);
    return new Promise((resolve) => {
      noise.onended = () => {
        this.stopCurrent = null;
        out.disconnect();
        resolve();
      };
      this.stopCurrent = () => {
        try { voice.stop(); noise.stop(); } catch { /* schon beendet */ }
      };
    });
  }

  /** Kontaktklick: gedämpfte Schwingung mit kurzem Impuls (etwa 12 ms) */
  private click(ctx: AudioContext, out: AudioNode, at: number, freq: number, level: number): void {
    let buffer = this.clicks.get(freq);
    if (!buffer) {
      const len = Math.round(ctx.sampleRate * 0.012);
      buffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        data[i] = (Math.sin(2 * Math.PI * freq * t) * 0.8 + (i < 12 ? 1 : 0)) * Math.exp(-t / 0.0018);
      }
      this.clicks.set(freq, buffer);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = level;
    src.connect(biquad(ctx, 'highpass', 300, 0.7)).connect(gain).connect(out);
    src.start(at);
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  private speakFallback(msg: RadioMessage): Promise<void> {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(msg.spoken);
      u.lang = msg.voice === 'gb' ? 'en-GB' : 'en-US';
      u.rate = msg.from === 'atc' ? 1.15 : 1.05;
      u.pitch = msg.from === 'atc' ? 0.9 : 0.8 + (msg.speaker % 5) * 0.1;
      const timer = setTimeout(() => finish(), 15_000);
      const finish = () => { clearTimeout(timer); resolve(); };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
    });
  }
}

/** Ende der Sprache im Puffer (letzte Stelle über der Rauschgrenze) */
function speechEnd(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let i = data.length - 1;
  while (i > 0 && Math.abs(data[i]) < 0.01) i--;
  return Math.min(buffer.duration, i / buffer.sampleRate);
}
