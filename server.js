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
const VOICE = process.env.TTS_VOICE || 'en-US-AndrewNeural';

// ---------- small helpers ----------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 200, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function download(url, dest, headers = {}) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 90000, headers });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    res.data.on('error', reject);
  });
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

const FALLBACK_STORIES = [
  {
    hook: "The Knock",
    beats: [
      { text: "The knock came at 2 AM, three soft taps, exactly like she used to knock.", imagePrompt: "dark hallway at night, single wooden door, faint knock vibration, eerie illustrated horror art style, muted deep blue and black palette, moody lighting, digital painting" },
      { text: "I hadn't spoken to my sister in five years.", imagePrompt: "lonely figure standing at a doorway at night, silhouette, illustrated horror art style, cold blue tones, digital painting" },
      { text: "I opened the door anyway.", imagePrompt: "door slowly opening into darkness, illustrated horror art style, high contrast shadows, digital painting" },
      { text: "No one was there.", imagePrompt: "empty dark porch at night, illustrated horror art style, unsettling emptiness, digital painting" },
      { text: "Just her scarf, folded neatly on the mat, the one she was buried in.", imagePrompt: "folded scarf on a doormat at night, close up, illustrated horror art style, eerie detail, digital painting" },
      { text: "I brought it inside without thinking.", imagePrompt: "hand reaching to pick up a scarf, dim interior light, illustrated horror art style, digital painting" },
      { text: "That night I heard three soft taps again, from inside my closet.", imagePrompt: "closet door in a dark bedroom, faint light under the door, illustrated horror art style, tense atmosphere, digital painting" },
      { text: "I still haven't opened it.", imagePrompt: "closed closet door, shadows creeping at the edges, illustrated horror art style, digital painting" },
      { text: "But every night, at 2 AM, the knocking gets a little closer to the bedroom door.", imagePrompt: "bedroom door at night, ominous shadow beneath it, illustrated horror art style, dread atmosphere, digital painting" }
    ]
  },
  {
    hook: "The Playback",
    beats: [
      { text: "I found an old voice recorder in my dad's things after he passed.", imagePrompt: "old cassette voice recorder among dusty belongings, illustrated horror art style, warm dim light fading to shadow, digital painting" },
      { text: "One tape was labeled with just tonight's date, from ten years ago.", imagePrompt: "handwritten label on a cassette tape, close up, illustrated horror art style, unsettling detail, digital painting" },
      { text: "I pressed play, expecting his voice.", imagePrompt: "finger pressing play button on old recorder, tense close up, illustrated horror art style, digital painting" },
      { text: "Instead, I heard my own voice, calm, whispering things I haven't said yet.", imagePrompt: "person listening in shock in a dim room, illustrated horror art style, cold color palette, digital painting" },
      { text: "It described this exact room, this exact chair, word for word.", imagePrompt: "empty chair in a dim room, illustrated horror art style, eerie symmetry, digital painting" },
      { text: "Then it said my name, and told me to turn around.", imagePrompt: "silhouette frozen mid turn in a dark room, illustrated horror art style, high tension, digital painting" },
      { text: "I didn't.", imagePrompt: "back of a person's head, unmoving, dark room, illustrated horror art style, digital painting" },
      { text: "The tape ended there.", imagePrompt: "cassette player stopped, small red light glowing, illustrated horror art style, digital painting" },
      { text: "I still haven't turned around, and the recorder, somehow, is still running.", imagePrompt: "cassette recorder still spinning with no tape moving, ominous glow, illustrated horror art style, dread, digital painting" }
    ]
  }
];

async function generateStory() {
  if (!GEMINI_API_KEY) {
    return FALLBACK_STORIES[Math.floor(Math.random() * FALLBACK_STORIES.length)];
  }

  const prompt = `Write ONE original short horror story for a 35-45 second narrated video.
Rules:
- Tight, atmospheric, first-person, told plainly like a true creepypasta account, not campy.
- Must build dread steadily and land on a genuinely unsettling final line - no jump-scare cliches, no "and then I woke up", no demons/exorcism tropes. Something quiet and wrong.
- Total narration 90-110 words, broken into 8-10 short beats (one or two sentences each).
- For each beat, also give a matching illustrated-horror-art image prompt describing ONLY the visual (setting, framing, mood, lighting) - never describe gore, never depict a real person, keep it suggestive and atmospheric, always end each image prompt with ", illustrated horror art style, digital painting".
- Also give a short punchy title (max 4 words).
Respond with ONLY raw JSON, no markdown, no backticks:
{"hook":"...","beats":[{"text":"...","imagePrompt":"..."}, ...]}`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 45000 }
    );
    let text = res.data.candidates[0].content.parts[0].text.trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(text);
    if (!parsed.beats?.length) throw new Error('bad shape');
    return parsed;
  } catch (e) {
    console.error('Gemini failed, using fallback story:', e.message);
    return FALLBACK_STORIES[Math.floor(Math.random() * FALLBACK_STORIES.length)];
  }
}

// ---------- 2. narration ----------

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function narrate(text, outPath) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(text);
  await withTimeout(new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath);
    audioStream.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
    audioStream.on('error', reject);
  }), 45000, 'Narration');
  return { outPath, wordTimings: [] };
}

// ---------- 3. illustrated visuals ----------

async function generateImage(prompt, destPath) {
  const fullPrompt = `${prompt}, cinematic lighting, ultra detailed, high quality illustration, sharp focus`;
  const encoded = encodeURIComponent(fullPrompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=1365&model=flux&enhance=true&nologo=true&seed=${Math.floor(Math.random() * 100000)}`;
  await download(url, destPath);
}

// ---------- 4. captions ----------

// Split narration into small on-screen chunks, timed proportionally to how many
// characters each chunk has (longer words/phrases get more on-screen time), which
// tracks natural speech pacing far better than dividing time equally per chunk.
function buildCaptionChunks(script, totalDuration, wordsPerChunk = 1) {
  const words = script.split(/\s+/).filter(Boolean);
  const chunkTexts = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunkTexts.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  const weights = chunkTexts.map(t => Math.max(3, t.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const chunks = [];
  let cursor = 0;
  for (let i = 0; i < chunkTexts.length; i++) {
    const dur = (weights[i] / totalWeight) * totalDuration;
    chunks.push({ text: chunkTexts[i], start: cursor, end: cursor + dur });
    cursor += dur;
  }
  return chunks;
}

// Preferred path: build caption chunks from the TTS engine's real per-word timings.
function chunksFromWordTimings(wordTimings, wordsPerChunk = 3) {
  const chunks = [];
  for (let i = 0; i < wordTimings.length; i += wordsPerChunk) {
    const group = wordTimings.slice(i, i + wordsPerChunk);
    chunks.push({
      text: group.map(w => w.text).join(' '),
      start: group[0].start,
      end: group[group.length - 1].end
    });
  }
  return chunks;
}

// ---------- 5. build the video ----------

async function buildShort(jobId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(TMP_DIR, stamp);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    jobs[jobId].progress = 'Writing the story';
    const story = await generateStory();
    const fullScript = story.beats.map(b => b.text).join(' ');

    jobs[jobId].progress = 'Recording narration';
    const narrationPath = path.join(jobDir, 'narration.mp3');
    const { wordTimings } = await narrate(fullScript, narrationPath);
    const duration = await getDuration(narrationPath);

    // Time each beat's on-screen image proportionally to how much of the
    // narration it represents, so visuals change exactly on story beats.
    const weights = story.beats.map(b => Math.max(4, b.text.length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let cursor = 0;
    const beatTimings = story.beats.map((b, i) => {
      const dur = (weights[i] / totalWeight) * duration;
      const timing = { ...b, start: cursor, dur };
      cursor += dur;
      return timing;
    });

    jobs[jobId].progress = 'Illustrating the scene';
    const segPaths = [];
    for (let i = 0; i < beatTimings.length; i++) {
      const imgPath = path.join(jobDir, `img_${i}.jpg`);
      await generateImage(beatTimings[i].imagePrompt, imgPath);

      const dur = Math.max(0.6, beatTimings[i].dur);
      const fps = 25;
      const frames = Math.max(1, Math.round(dur * fps));
      const variant = i % 4;
      const zoompans = [
        `zoompan=z='min(zoom+0.0011,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=${fps}`,
        `zoompan=z='if(lte(on,1),1.18,max(1.0,zoom-0.0011))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=${fps}`,
        `zoompan=z='1.16':x='if(lte(on,1),(iw-iw/1.16)/2,x+0.55)':y='(ih-ih/1.16)/2':d=${frames}:s=720x1280:fps=${fps}`,
        `zoompan=z='1.16':x='if(lte(on,1),(iw-iw/1.16)/2,x-0.55)':y='(ih-ih/1.16)/2-0.3':d=${frames}:s=720x1280:fps=${fps}`
      ];
      const zoompan = zoompans[variant];

      const out = path.join(jobDir, `seg_${i}.mp4`);
      await run('ffmpeg', [
        '-y', '-loop', '1', '-i', imgPath,
        '-vf', `scale=760:-1,${zoompan},eq=contrast=1.08:saturation=0.85:brightness=-0.03,format=yuv420p`,
        '-t', String(dur), '-r', String(fps),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-threads', '1',
        out
      ]);
      segPaths.push(out);
    }

    jobs[jobId].progress = 'Stitching the scenes';
    const listFile = path.join(jobDir, 'list.txt');
    fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));
    const stitched = path.join(jobDir, 'stitched.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', stitched]);

    // captions: small, understated, sitting a little below center - never the focus
    jobs[jobId].progress = 'Adding captions';
    const expectedWords = fullScript.split(/\s+/).filter(Boolean).length;
    const timingsUsable = wordTimings.length >= expectedWords * 0.7;
    const chunks = timingsUsable
      ? chunksFromWordTimings(wordTimings, 3)
      : buildCaptionChunks(fullScript, duration, 3);
    const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const filters = [];

    filters.push(`drawtext=fontfile=${FONT}:text='${esc(story.hook.toUpperCase())}':fontcolor=white@0.9:fontsize=40:borderw=3:bordercolor=black:x=(w-tw)/2:y=140:enable='between(t,0,2.2)'`);

    for (const c of chunks) {
      filters.push(
        `drawtext=fontfile=${FONT}:text='${esc(c.text)}':fontcolor=white@0.85:fontsize=30:borderw=2:bordercolor=black:x=(w-tw)/2:y=h/2+140:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`
      );
    }

    jobs[jobId].progress = 'Building the dread (audio)';
    const pulsePath = path.join(jobDir, 'pulse.wav');
    await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `sine=frequency=60:duration=${duration}`,
      '-af', 'tremolo=f=1.4:d=0.75,volume=0.055',
      pulsePath
    ]);
    const mixedAudio = path.join(jobDir, 'mixed.mp3');
    await run('ffmpeg', [
      '-y', '-i', narrationPath, '-i', pulsePath,
      '-filter_complex', '[0:a]volume=1.0[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first[aout]',
      '-map', '[aout]',
      mixedAudio
    ]);

    const finalName = `short_${stamp}.mp4`;
    const finalPath = path.join(OUTPUT_DIR, finalName);
    await run('ffmpeg', [
      '-y', '-i', stitched, '-i', mixedAudio,
      '-vf', filters.join(',') + ',vignette=PI/3.5',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-threads', '1',
      '-c:a', 'aac', '-b:a', '160k',
      '-shortest',
      finalPath
    ]);

    fs.rmSync(jobDir, { recursive: true, force: true });

    const entry = {
      file: finalName,
      url: `${BASE_URL}/output/${finalName}`,
      hook: story.hook,
      script: fullScript,
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

const jobs = {}; // jobId -> { status, progress, entry, error }

app.get('/make-short', (req, res) => {
  if (building) return res.status(429).json({ error: 'A video is already being built. Try again shortly.' });
  building = true;
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  jobs[jobId] = { status: 'processing', progress: 'Starting' };

  buildShort(jobId)
    .then(entry => { jobs[jobId] = { status: 'done', entry }; })
    .catch(err => { console.error('Build failed:', err); jobs[jobId] = { status: 'error', error: err.message }; })
    .finally(() => { building = false; });

  res.json({ jobId });
});

app.get('/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json(job);
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
<button id="makeBtn" onclick="startBuild()">Make one now</button>
<p id="status" style="color:#888;font-size:13px;margin-top:10px"></p>
<script>
function startBuild(){
  const btn = document.getElementById('makeBtn');
  const status = document.getElementById('status');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  fetch('/make-short').then(r=>r.json()).then(data=>{
    if (data.error) { status.textContent = data.error; btn.disabled=false; btn.textContent='Make one now'; return; }
    poll(data.jobId);
  }).catch(e=>{ status.textContent = 'Could not start: ' + e.message; btn.disabled=false; btn.textContent='Make one now'; });
}
function poll(jobId){
  const btn = document.getElementById('makeBtn');
  const status = document.getElementById('status');
  fetch('/job/' + jobId).then(r=>r.json()).then(job=>{
    if (job.status === 'processing') {
      status.textContent = job.progress || 'Working…';
      setTimeout(() => poll(jobId), 4000);
    } else if (job.status === 'done') {
      status.textContent = 'Done!';
      location.reload();
    } else {
      status.textContent = 'Failed: ' + (job.error || 'unknown error');
      btn.disabled = false;
      btn.textContent = 'Make one now';
    }
  }).catch(()=>{ setTimeout(() => poll(jobId), 5000); });
}
</script>
<div style="height:20px"></div>
${cards || '<p class="empty">No videos yet. Press “Make one now” to generate the first one.</p>'}
</body></html>`);
});

app.use('/output', express.static(OUTPUT_DIR));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shorts server running on ${PORT}`));
