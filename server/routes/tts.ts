// Sprachausgabe für den Funkverkehr: reicht Anfragen an den Piper-Dienst (atc-tts) weiter
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();
const TTS_URL = process.env.TTS_URL ?? 'http://atc-tts:5002';
const VOICES = ['atc', 'us', 'gb'];
const MAX_TEXT = 300;
const CACHE_MAX = 150;
// Einfache LRU: Map behält die Einfügereihenfolge, der älteste Eintrag fliegt zuerst
const cache = new Map<string, Buffer>();

// Eigene Grenze: pro Funkspruch eine Anfrage, deutlich mehr als bei den übrigen Routen
router.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

// [[ … ]]: Lautschrift für Ortsnamen (spokenName)
router.get('/', async (req, res) => {
  const voice = String(req.query.voice ?? 'atc');
  const speaker = Math.max(0, Math.min(999, parseInt(String(req.query.speaker ?? '0'), 10) || 0));
  const text = String(req.query.text ?? '').trim();
  if (!VOICES.includes(voice) || !text || text.length > MAX_TEXT || !/^[\p{L}\p{N}\s,.'[\]-]+$/u.test(text)) {
    res.status(400).json({ error: 'Ungültige Anfrage' });
    return;
  }

  const key = `${voice}|${speaker}|${text}`;
  let wav = cache.get(key);
  if (wav) {
    cache.delete(key);
  } else {
    try {
      const r = await fetch(`${TTS_URL}/tts?voice=${voice}&speaker=${speaker}&text=${encodeURIComponent(text)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      wav = Buffer.from(await r.arrayBuffer());
    } catch (err) {
      console.warn('tts: Sprachdienst nicht erreichbar:', (err as Error).message);
      res.status(503).json({ error: 'Sprachdienst nicht verfügbar' });
      return;
    }
  }
  cache.set(key, wav);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(wav);
});

export default router;
