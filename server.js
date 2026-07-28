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

const jobs = {}; // jobId -> { status, progress, videoUrl, error }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 300 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`ffmpeg error (${cmd} ${args.slice(0, 6).join(' ')}...):`, stderr);
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

async function getDuration(filePath) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
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

function esc(t) {
  return t.replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function srtTs(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.round((s % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${sec},${ms}`;
}

// Build one scene's clip: splits its narration into ~13s image segments with alternating
// zoom-in / pan-right Ken Burns motion, hard-cut between segments, then attaches the
// scene's continuous narration audio on top.
async function buildSceneClip(jobDir, sceneIdx, scene) {
  const narrationPath = path.join(jobDir, `narration_${sceneIdx}.mp3`);
  await generateNarration(scene.text, narrationPath);
  const totalDuration = await getDuration(narrationPath);

  const targetSeg = 13;
  const segCount = Math.max(1, Math.round(totalDuration / targetSeg));
  const segDuration = totalDuration / segCount;
  const fps = 25;

  const segClips = [];
  for (let s = 0; s < segCount; s++) {
    const variant = s % 2;
    const imgPath = path.join(jobDir, `img_${sceneIdx}_${s}.jpg`);
    const suffix = variant === 0 ? ', wide establishing shot' : ', close detail shot';
    await generateImage(scene.imagePrompt + suffix, imgPath);

    const frames = Math.max(1, Math.round(segDuration * fps));
    const zoompan = variant === 0
      ? `zoompan=z='min(zoom+0.0012,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${fps}`
      : `zoompan=z='1.15':x='if(lte(on,1),(iw-iw/1.15)/2,x+0.7)':y='(ih-ih/1.15)/2':d=${frames}:s=1920x1080:fps=${fps}`;

    const segClip = path.join(jobDir, `seg_${sceneIdx}_${s}.mp4`);
    await run('ffmpeg', [
      '-y', '-loop', '1', '-i', imgPath,
      '-vf', `scale=2200:-1,${zoompan},format=yuv420p`,
      '-t', String(segDuration), '-r', String(fps),
      segClip
    ]);
    segClips.push(segClip);
  }

  const listFile = path.join(jobDir, `seglist_${sceneIdx}.txt`);
  fs.writeFileSync(listFile, segClips.map(p => `file '${p}'`).join('\n'));
  const silentScene = path.join(jobDir, `silent_scene_${sceneIdx}.mp4`);
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silentScene]);

  const sceneClip = path.join(jobDir, `scene_${sceneIdx}.mp4`);
  await run('ffmpeg', ['-y', '-i', silentScene, '-i', narrationPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', sceneClip]);

  return { path: sceneClip, duration: totalDuration };
}

// Chain scene clips together with a real crossfade dissolve (video + audio) between each.
async function crossfadeChain(jobDir, clips, transition = 0.6) {
  if (clips.length === 1) return clips[0].path;

  let inputs = [];
  let filterParts = [];
  let cumulative = clips[0].duration;
  let lastV = '0:v';
  let lastA = '0:a';

  clips.forEach(c => inputs.push('-i', c.path));

  for (let i = 1; i < clips.length; i++) {
    const offset = Math.max(0, cumulative - transition);
    const outV = `v${i}`;
    const outA = `a${i}`;
    filterParts.push(`[${lastV}][${i}:v]xfade=transition=fade:duration=${transition}:offset=${offset.toFixed(2)}[${outV}]`);
    filterParts.push(`[${lastA}][${i}:a]acrossfade=d=${transition}[${outA}]`);
    lastV = outV;
    lastA = outA;
    cumulative = cumulative + clips[i].duration - transition;
  }

  const outPath = path.join(jobDir, 'chained.mp4');
  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', `[${lastV}]`, '-map', `[${lastA}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-c:a', 'aac',
    outPath
  ]);
  return outPath;
}

async function processJob(jobId, payload) {
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      scenes,
      channelName = 'Shayan Paras',
      ctaText = 'Subscribe & hit the bell',
      ctaSceneIndexes = [],
      titleSceneIndexes = [],
      outroSceneIndexes = []
    } = payload;

    const clips = [];
    for (let i = 0; i < scenes.length; i++) {
      jobs[jobId].progress = `Building scene ${i + 1}/${scenes.length}`;
      clips.push(await buildSceneClip(jobDir, i, scenes[i]));
    }

    jobs[jobId].progress = 'Crossfading scenes together';
    const chained = await crossfadeChain(jobDir, clips);
    const totalDuration = await getDuration(chained);

    jobs[jobId].progress = 'Adding ambient background bed';
    const ambientPath = path.join(jobDir, 'ambient.wav');
    await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `anoisesrc=color=brown:duration=${totalDuration}:sample_rate=44100`,
      '-af', 'lowpass=f=400,volume=0.05',
      ambientPath
    ]);
    const withAmbient = path.join(jobDir, 'with_ambient.mp4');
    await run('ffmpeg', [
      '-y', '-i', chained, '-i', ambientPath,
      '-filter_complex', '[0:a]volume=1.0[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]',
      '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac',
      withAmbient
    ]);

    jobs[jobId].progress = 'Building captions and overlays';
    const srtLines = [];
    let cursor = 0;
    for (let i = 0; i < clips.length; i++) {
      srtLines.push(`${i + 1}\n${srtTs(cursor)} --> ${srtTs(cursor + clips[i].duration)}\n${scenes[i].text.slice(0, 140)}\n`);
      cursor += clips[i].duration;
    }
    const srtPath = path.join(jobDir, 'captions.srt');
    fs.writeFileSync(srtPath, srtLines.join('\n'));

    const filters = [
      `eq=contrast=1.05:saturation=1.1`,
      `vignette=PI/4`,
      `drawtext=text='${esc(channelName)}':fontcolor=white@0.85:fontsize=28:box=1:boxcolor=black@0.35:boxborderw=8:x=w-tw-30:y=h-th-30`,
      `subtitles='${srtPath.replace(/:/g, '\\:')}':force_style='FontSize=20,PrimaryColour=&HFFFFFF&'`
    ];

    cursor = 0;
    for (let i = 0; i < clips.length; i++) {
      const start = cursor;
      const end = cursor + clips[i].duration;
      if (ctaSceneIndexes.includes(i)) {
        filters.push(`drawtext=text='${esc(ctaText)}':fontcolor=white:fontsize=36:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-tw)/2:y=h-th-80:enable='between(t,${(start + 2).toFixed(2)},${(start + 8).toFixed(2)})'`);
      }
      if (titleSceneIndexes.includes(i)) {
        filters.push(`drawtext=text='${esc(channelName.toUpperCase())}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.4:boxborderw=16:x=(w-tw)/2:y=(h-th)/2:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`);
      }
      if (outroSceneIndexes.includes(i)) {
        filters.push(`drawtext=text='Subscribe for more true stories':fontcolor=white:fontsize=44:box=1:boxcolor=black@0.5:boxborderw=14:x=(w-tw)/2:y=(h-th)/2:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`);
      }
      cursor = end;
    }

    const finalPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
    await run('ffmpeg', [
      '-y', '-i', withAmbient,
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'copy',
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
  processJob(jobId, req.body);
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
