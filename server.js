/**
 * Ojasv's Cookbook — Backend Proxy
 * 
 * This server keeps your Gemini API key private.
 * The frontend calls /api/recipe instead of Gemini directly,
 * and this server forwards the request with the secret key attached.
 *
 * Usage:
 *   1. Put your key in .env  →  GEMINI_API_KEY=AIza...
 *   2. npm install
 *   3. node server.js
 *   4. Open http://localhost:3000
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_API_KEY') {
  console.error('\n⚠️  Missing API key! Add your Gemini key to .env:\n   GEMINI_API_KEY=AIza...\n');
  process.exit(1);
}

// ── Middleware ──────────────────────────────────────────
app.use(express.json());

// Serve only index.html — don't expose .env, server.js, etc.
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// ── Helper: call Gemini with auto-retry on rate limits ──
async function callGemini(body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let apiRes;
    try {
      apiRes = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (networkErr) {
      const err = new Error('Network error — unable to reach Gemini API. Check your internet connection.');
      err.status = 503;
      throw err;
    }

    if (apiRes.ok) return apiRes;

    // Rate-limited (429) → wait and retry
    if (apiRes.status === 429 && attempt < retries) {
      // Try to parse the retry delay from the error, fallback to exponential backoff
      const errBody = await apiRes.json().catch(() => ({}));
      const retryMatch = JSON.stringify(errBody).match(/retry in ([\d.]+)s/i);
      const waitSec = retryMatch ? parseFloat(retryMatch[1]) + 1 : attempt * 5;
      console.log(`⏳ Rate limited — retrying in ${waitSec.toFixed(1)}s (attempt ${attempt}/${retries})`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    // Non-429 error or final attempt — throw with details
    const errData = apiRes.status === 429
      ? { error: { message: 'rate_limit' } }
      : await apiRes.json().catch(() => ({}));
    const err = new Error(errData?.error?.message || `Gemini API error (${apiRes.status})`);
    err.status = apiRes.status;
    throw err;
  }
}

// ── Proxy endpoint ─────────────────────────────────────
app.post('/api/recipe', async (req, res) => {
  const { ingredients } = req.body;

  if (!Array.isArray(ingredients) || ingredients.length !== 3) {
    return res.status(400).json({ error: 'Provide exactly 3 ingredients.' });
  }

  const prompt =
    `You are a world-class chef. I have exactly these three ingredients in my fridge:\n` +
    `1. ${ingredients[0]}\n` +
    `2. ${ingredients[1]}\n` +
    `3. ${ingredients[2]}\n\n` +
    `Create ONE delicious recipe using these ingredients (you may add common pantry staples like salt, pepper, oil, butter, etc.).\n\n` +
    `Format your response EXACTLY like this:\n` +
    `## Recipe Name\n` +
    `A one-line description of the dish.\n\n` +
    `### Ingredients\n` +
    `- list each ingredient with quantity\n\n` +
    `### Instructions\n` +
    `1. numbered step-by-step instructions\n\n` +
    `### Chef's Tip\n` +
    `A short pro-tip to elevate the dish.`;

  try {
    const apiRes = await callGemini({
      contents: [{ parts: [{ text: prompt }] }]
    });

    const data = await apiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw Object.assign(
        new Error('Gemini returned an empty response — the content may have been blocked by safety filters. Try different ingredients.'),
        { status: 500 }
      );
    }

    res.json({ text });
  } catch (err) {
    console.error('Proxy error:', err.message);

    // Friendly message for rate limits
    if (err.message === 'rate_limit' || err.status === 429) {
      return res.status(429).json({
        error: '🍳 Our kitchen is a bit busy right now! Please try again in about 30 seconds.',
        retryable: true
      });
    }

    res.status(err.status || 500).json({
      error: 'Something went wrong — please try again shortly.'
    });
  }
});

// ── Start ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍳 Ojasv's Cookbook running at http://localhost:${PORT}\n`);
});
