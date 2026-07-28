const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
app.use(express.json({ limit: '5mb' }));

const TMP_DIR = path.join(__dirname, 'tmp');
const OUTPUT_DIR = path.join(__dirname, 'public', 'output');
const INDEX_FILE = path.join(__dirname, 'public', 'index.json');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'Shayan Paras';
const VOICE = process.env.TTS_VOICE || 'en-US-GuyNeural';

// ---------- small helpers ----------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function download(url, dest, headers = {}) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 90000, headers });
  fs.writeFileSync(dest, res.data);
  return dest;
}

async function getDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return parseFloat(out.trim());
}

function esc(t) {
  return String(t)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")   // curly apostrophe avoids ffmpeg quoting pain
    .replace(/%/g, '\\%');
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return []; }
}
function writeIndex(list) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list.slice(0, 60), null, 2));
}

// ---------- 1. the script ----------

const FALLBACK_FACTS = [
  { hook: "Your bones are stronger than steel", script: "Ounce for ounce, human bone is stronger than steel. A block of bone the size of a matchbox can support around nine tonnes. That is roughly four times what concrete can handle. The reason you still break bones is not weakness. It is that your skeleton trades some raw strength for being light enough to actually carry around.", keywords: ["human skeleton", "x-ray bone", "running athlete"] },
  { hook: "There is a planet made of diamond", script: "Fifty light years from Earth sits a planet called fifty five Cancri e. It orbits so close to its star that its surface is molten. But underneath, the extreme pressure and carbon rich chemistry mean a large part of its interior may be crystallised into diamond. A planet worth more than every economy on Earth combined, and completely impossible to reach.", keywords: ["space planet", "diamond crystal", "galaxy stars"] },
  { hook: "Bananas are radioactive", script: "Every banana you eat is slightly radioactive. Bananas are rich in potassium, and a small fraction of natural potassium is an unstable isotope that decays. The dose is so tiny it is harmless, but it is real enough that scientists jokingly measure radiation exposure in banana equivalent doses. You would need to eat roughly ten million bananas at once to be in danger.", keywords: ["bananas fruit", "science laboratory", "grocery store"] },
  { hook: "Octopuses have three hearts", script: "An octopus has three hearts and blue blood. Two hearts pump blood to the gills, and one pumps it to the rest of the body. That third heart actually stops beating whenever the octopus swims, which is why they prefer crawling. Swimming exhausts them. Their blood is blue because it carries oxygen using copper instead of iron.", keywords: ["octopus underwater", "ocean deep sea", "marine life"] },
  { hook: "A day on Venus is longer than its year", script: "Venus rotates so slowly that a single day there lasts about two hundred and forty three Earth days. But it orbits the sun in only two hundred and twenty five. That means on Venus, a day is longer than a year. And to make it stranger, Venus spins backwards, so the sun rises in the west and sets in the east.", keywords: ["venus planet", "solar system", "space nebula"] }
];

async function generateScript() {
  if (!GEMINI_API_KEY) {
    return FALLBACK_FACTS[Math.floor(Math.random() * FALLBACK_FACTS.length)];
  }

  const prompt = `Generate ONE mind-blowing "did you know" fact for a 35-second YouTube Short.
Rules:
- Must be genuinely surprising, true, and verifiable. No myths, no urban legends.
- Avoid the most overused facts (honey never spoils, Cleopatra/pyramids, sharks older than trees).
- Narration must be 80-95 words, written to be spoken aloud, plain conversational English.
- Open with the single most surprising sentence. No "did you know" phrasing, no greetings.
- End on a line that lands, not a question.
Also give a short punchy on-screen hook (max 6 words) and 3 stock-footage search terms
(simple, literal, visual - things a stock video site would actually have).
Respond with ONLY raw JSON, no markdown, no backticks:
{"hook":"...","script":"...","keywords":["...","...","..."]}`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 45000 }
    );
    let text = res.data.candidates[0].content.parts[0].text.trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(text);
    if (!parsed.script || !parsed.keywords?.length) throw new Error('bad shape');
    return parsed;
  } catch (e) {
    console.error('Gemini failed, using fallback fact:', e.message);
    return FALLBACK_FACTS[Math.floor(Math.random() * FALLBACK_FACTS.length)];
  }
}

// ---------- 2. narration ----------

async function narrate(text, outPath) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(text);
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath);
    audioStream.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
    audioStream.on('error', reject);
  });
  return outPath;
}

// ---------- 3. stock footage ----------

async function fetchStockClips(keywords, count, jobDir) {
  if (!PEXELS_API_KEY) throw new Error('PEXELS_API_KEY is not set on the server');

  const collected = [];
  let ki = 0;

  while (collected.length < count && ki < keywords.length * 3) {
    const term = keywords[ki % keywords.length];
    ki++;
    try {
      const res = await axios.get('https://api.pexels.com/videos/search', {
        headers: { Authorization: PEXELS_API_KEY },
        params: { query: term, orientation: 'portrait', per_page: 8, size: 'medium' },
        timeout: 30000
      });
      const vids = res.data.videos || [];
      for (const v of vids) {
        if (collected.length >= count) break;
        if (collected.find(c => c.id === v.id)) continue;
        const file = (v.video_files || [])
          .filter(f => f.file_type === 'video/mp4')
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (file) collected.push({ id: v.id, url: file.link });
      }
    } catch (e) {
      console.error(`Pexels search failed for "${term}":`, e.message);
    }
  }

  if (!collected.length) throw new Error('No stock footage found for: ' + keywords.join(', '));

  // if we found fewer than needed, cycle through what we have
  const paths = [];
  for (let i = 0; i < count; i++) {
    const src = collected[i % collected.length];
    const dest = path.join(jobDir, `stock_${i}.mp4`);
    if (i < collected.length) {
      await download(src.url, dest);
    } else {
      fs.copyFileSync(path.join(jobDir, `stock_${i % collected.length}.mp4`), dest);
    }
    paths.push(dest);
  }
  return paths;
}

// ---------- 4. captions ----------

// Split narration into small on-screen chunks and spread them evenly across the audio.
function buildCaptionChunks(script, totalDuration, wordsPerChunk = 3) {
  const words = script.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  const per = totalDuration / chunks.length;
  return chunks.map((text, i) => ({
    text,
    start: i * per,
    end: (i + 1) * per
  }));
}

// ---------- 5. build the video ----------

async function buildShort() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(TMP_DIR, stamp);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const fact = await generateScript();

    const narrationPath = path.join(jobDir, 'narration.mp3');
    await narrate(fact.script, narrationPath);
    const duration = await getDuration(narrationPath);

    const segLen = 4;
    const segCount = Math.max(2, Math.ceil(duration / segLen));
    const stockPaths = await fetchStockClips(fact.keywords, segCount, jobDir);

    // normalise each clip: vertical 1080x1920, silent, fixed length
    const segPaths = [];
    const actualSeg = duration / segCount;
    for (let i = 0; i < stockPaths.length; i++) {
      const out = path.join(jobDir, `seg_${i}.mp4`);
      await run('ffmpeg', [
        '-y', '-i', stockPaths[i],
        '-t', String(actualSeg),
        '-an',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        out
      ]);
      segPaths.push(out);
    }

    const listFile = path.join(jobDir, 'list.txt');
    fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));
    const stitched = path.join(jobDir, 'stitched.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', stitched]);

    // captions + hook + channel tag
    const chunks = buildCaptionChunks(fact.script, duration);
    const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const filters = [];

    filters.push(`drawtext=fontfile=${FONT}:text='${esc(fact.hook.toUpperCase())}':fontcolor=white:fontsize=76:borderw=6:bordercolor=black:x=(w-tw)/2:y=220:enable='between(t,0,2.5)'`);

    for (const c of chunks) {
      filters.push(
        `drawtext=fontfile=${FONT}:text='${esc(c.text.toUpperCase())}':fontcolor=white:fontsize=72:borderw=7:bordercolor=black:x=(w-tw)/2:y=h-620:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`
      );
    }

    filters.push(`drawtext=fontfile=${FONT}:text='${esc(CHANNEL_NAME)}':fontcolor=white@0.8:fontsize=38:borderw=3:bordercolor=black:x=(w-tw)/2:y=h-160`);

    const finalName = `short_${stamp}.mp4`;
    const finalPath = path.join(OUTPUT_DIR, finalName);
    await run('ffmpeg', [
      '-y', '-i', stitched, '-i', narrationPath,
      '-vf', filters.join(','),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '21',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      finalPath
    ]);

    fs.rmSync(jobDir, { recursive: true, force: true });

    const entry = {
      file: finalName,
      url: `${BASE_URL}/output/${finalName}`,
      hook: fact.hook,
      script: fact.script,
      keywords: fact.keywords,
      duration: Math.round(duration),
      createdAt: new Date().toISOString()
    };
    const index = readIndex();
    index.unshift(entry);
    writeIndex(index);
    return entry;
  } catch (err) {
    fs.rmSync(jobDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------- routes ----------

let building = false;

app.get('/make-short', async (req, res) => {
  if (building) return res.status(429).json({ error: 'A video is already being built. Try again shortly.' });
  building = true;
  try {
    const entry = await buildShort();
    res.json({ ok: true, ...entry });
  } catch (err) {
    console.error('Build failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    building = false;
  }
});

app.get('/api/videos', (req, res) => res.json(readIndex()));

app.get('/', (req, res) => {
  const videos = readIndex();
  const cards = videos.map(v => `
    <div class="card">
      <video src="${v.url}" controls preload="metadata"></video>
      <div class="meta">
        <h2>${v.hook}</h2>
        <p class="date">${new Date(v.createdAt).toLocaleString()} &middot; ${v.duration}s</p>
        <p class="script">${v.script}</p>
        <a class="dl" href="${v.url}" download>Download</a>
      </div>
    </div>`).join('');

  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CHANNEL_NAME} — Daily Shorts</title>
<style>
  body{margin:0;background:#0e0e10;color:#eee;font-family:system-ui,-apple-system,sans-serif;padding:24px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:#888;font-size:14px;margin-bottom:24px}
  .card{display:flex;gap:20px;background:#18181b;border-radius:14px;padding:16px;margin-bottom:20px;flex-wrap:wrap}
  video{width:220px;border-radius:10px;background:#000}
  .meta{flex:1;min-width:240px}
  .meta h2{font-size:18px;margin:0 0 6px}
  .date{color:#888;font-size:13px;margin:0 0 10px}
  .script{color:#ccc;font-size:14px;line-height:1.5}
  .dl{display:inline-block;margin-top:12px;background:#e11d48;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:14px}
  .empty{color:#888}
  button{background:#27272a;color:#eee;border:0;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px}
</style></head><body>
<h1>${CHANNEL_NAME} — Daily Shorts</h1>
<p class="sub">A new short is generated automatically each day. Download and post.</p>
<button onclick="this.textContent='Building… this takes 1-3 min';fetch('/make-short').then(r=>r.json()).then(()=>location.reload()).catch(()=>location.reload())">Make one now</button>
<div style="height:20px"></div>
${cards || '<p class="empty">No videos yet. Press “Make one now” to generate the first one.</p>'}
</body></html>`);
});

app.use('/output', express.static(OUTPUT_DIR));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shorts server running on ${PORT}`));
