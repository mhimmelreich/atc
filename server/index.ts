// filepath: server/index.ts
import express from 'express';
import rateLimit from 'express-rate-limit';
import airportRouter from './routes/airport.js';
import trafficRouter from './routes/traffic.js';
import navdataRouter from './routes/navdata.js';
import opendataRouter from './routes/opendata.js';
import ttsRouter from './routes/tts.js';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// Trust Traefik/Cloudflare proxy headers
app.set('trust proxy', 1);

app.use(express.json());

// Sprachausgabe und Live-Verkehr vor dem allgemeinen Limit einhängen: sie haben eigene, höhere
app.use('/api/tts', ttsRouter);
app.use('/api/traffic', trafficRouter);

// Rate limiting
const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// CORS — only allow own origin in production
app.use((_req, res, next) => {
  const origin = process.env.NODE_ENV === 'production'
    ? 'https://atc.himmelreich.cloud'
    : '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.use('/api/airport', airportRouter);
app.use('/api/navdata', navdataRouter);
app.use('/api/opendata', opendataRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`atc-api listening on ${HOST}:${PORT}`);
});
