const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
app.use(express.json({ limit: '20mb' }));

const TMP_DIR = path.join(__dirname, 'tmp');
const OUTPUT_DIR = path.join(__dirname, 'public', 'output');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// In-memory job status tracker: { [jobId]: { status, progress, videoUrl, error } }
const jobs = {};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`ffmpeg error (${cmd} ${args.join(' ')}):`, stderr);
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout);
    });
  });
}

async function download(url, destPath) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  fs.writeFileSync(destPath, res.data);
  return destPath;
}

async function getAudioDuration(filePath) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  return parseFloat(out.trim());
}

async function generateNarration(text, outPath) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata('en-US-GuyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(text);
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outPath);
    audioStream.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function generateImage(prompt, outPath) {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1920&height=1080&nologo=true&seed=${Math.floor(Math.random() * 100000)}`;
  await download(url, outPath);
}

function escapeDrawtext(text) {
  return text.replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function srtTimestamp(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  const ms = String(Math.round((seconds % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${ms}`;
}

async function processJob(jobId, payload) {
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      scenes,
      channelName = 'Shayan Paras',
      ctaText = 'Subscribe & hit the bell',
      ctaSceneIndexes = []
    } = payload;

    const clipPaths = [];
    const srtLines = [];
    let elapsed = 0;

    for (let i = 0; i < scenes.length; i++) {
      jobs[jobId].progress = `Generating narration for scene ${i + 1}/${scenes.length}`;
      const narrationPath = path.join(jobDir, `narration_${i}.mp3`);
      await generateNarration(scenes[i].text, narrationPath);
      const duration = await getAudioDuration(narrationPath);

      jobs[jobId].progress = `Generating image for scene ${i + 1}/${scenes.length}`;
      const imagePath = path.join(jobDir, `image_${i}.jpg`);
      await generateImage(scenes[i].imagePrompt, imagePath);

      jobs[jobId].progress = `Building clip for scene ${i + 1}/${scenes.length}`;
      const fps = 25;
      const frames = Math.max(1, Math.round(duration * fps));
      const silentClip = path.join(jobDir, `silent_${i}.mp4`);
      await run('ffmpeg', [
        '-y',
        '-loop', '1',
        '-i', imagePath,
        '-vf', `scale=2200:-1,zoompan=z='min(zoom+0.0006,1.15)':d=${frames}:s=1920x1080:fps=${fps},format=yuv420p`,
        '-t', String(duration),
        '-r', String(fps),
        silentClip
      ]);

      const clipWithAudio = path.join(jobDir, `clip_${i}.mp4`);
      await run('ffmpeg', [
        '-y',
        '-i', silentClip,
        '-i', narrationPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-shortest',
        clipWithAudio
      ]);
      clipPaths.push(clipWithAudio);

      srtLines.push(
        `${i + 1}\n${srtTimestamp(elapsed)} --> ${srtTimestamp(elapsed + duration)}\n${scenes[i].text.slice(0, 120)}\n`
      );
      elapsed += duration;
    }

    jobs[jobId].progress = 'Concatenating scenes';
    const listFile = path.join(jobDir, 'concat_list.txt');
    fs.writeFileSync(listFile, clipPaths.map(p => `file '${p}'`).join('\n'));
    const combined = path.join(jobDir, 'combined.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', combined]);

    jobs[jobId].progress = 'Adding captions and branding';
    const srtPath = path.join(jobDir, 'captions.srt');
    fs.writeFileSync(srtPath, srtLines.join('\n'));

    const filters = [
      `drawtext=text='${escapeDrawtext(channelName)}':fontcolor=white@0.85:fontsize=28:box=1:boxcolor=black@0.35:boxborderw=8:x=w-tw-30:y=h-th-30`,
      `subtitles='${srtPath.replace(/:/g, '\\:')}':force_style='FontSize=20,PrimaryColour=&HFFFFFF&'`
    ];

    // CTA overlay shown briefly at the start of specified scene indexes
    let cursor = 0;
    for (let i = 0; i < scenes.length; i++) {
      const dur = clipPaths[i] ? await getAudioDuration(path.join(jobDir, `narration_${i}.mp3`)) : 0;
      if (ctaSceneIndexes.includes(i)) {
        const start = cursor + 2;
        const end = start + 6;
        filters.push(
          `drawtext=text='${escapeDrawtext(ctaText)}':fontcolor=white:fontsize=36:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-tw)/2:y=h-th-80:enable='between(t,${start},${end})'`
        );
      }
      cursor += dur;
    }

    const finalPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
    await run('ffmpeg', [
      '-y',
      '-i', combined,
      '-vf', filters.join(','),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-c:a', 'copy',
      finalPath
    ]);

    fs.rmSync(jobDir, { recursive: true, force: true });

    jobs[jobId] = { status: 'done', progress: 'Complete', videoUrl: `${BASE_URL}/output/${jobId}.mp4` };
  } catch (err) {
    console.error('Job failed:', err);
    jobs[jobId] = { status: 'error', progress: null, error: err.message };
  }
}

app.post('/render-full', (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', progress: 'Starting' };
  processJob(jobId, req.body); // fire and forget, tracked via /status
  res.json({ jobId, statusUrl: `${BASE_URL}/status/${jobId}` });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.use('/output', express.static(OUTPUT_DIR));
app.get('/', (req, res) => res.send('Paras render server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render server listening on port ${PORT}`));
