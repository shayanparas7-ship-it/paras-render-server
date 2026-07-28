const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '20mb' }));

const TMP_DIR = path.join(__dirname, 'tmp');
const OUTPUT_DIR = path.join(__dirname, 'public', 'output');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg error:', stderr);
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout);
    });
  });
}

async function download(url, destPath) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, res.data);
  return destPath;
}

function escapeDrawtext(text) {
  return text.replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * POST /render
 * body: {
 *   scenes: [{ imageUrl: string, durationSec: number }],
 *   narrationUrl: string,   // single stitched narration mp3 for the whole video
 *   musicUrl: string,       // background music track (looped/trimmed to length)
 *   captionsSrt: string,    // optional, full SRT content as a string
 *   channelName: string,    // e.g. "Shayan Paras"
 *   ctaText: string,        // e.g. "Subscribe & hit the bell"
 *   ctaStartSec: number,    // when to show the CTA overlay
 *   ctaEndSec: number
 * }
 */
app.post('/render', async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      scenes,
      narrationUrl,
      musicUrl,
      captionsSrt,
      channelName = 'Shayan Paras',
      ctaText = 'Subscribe & hit the bell',
      ctaStartSec = 5,
      ctaEndSec = 10
    } = req.body;

    if (!scenes || !scenes.length || !narrationUrl) {
      return res.status(400).json({ error: 'scenes[] and narrationUrl are required' });
    }

    // 1. Download all scene images
    const imagePaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const imgPath = path.join(jobDir, `scene_${i}.jpg`);
      await download(scenes[i].imageUrl, imgPath);
      imagePaths.push(imgPath);
    }

    // 2. Build a Ken Burns (slow zoom/pan) clip per scene
    const clipPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const duration = scenes[i].durationSec || 6;
      const fps = 25;
      const frames = Math.round(duration * fps);
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      await run('ffmpeg', [
        '-y',
        '-loop', '1',
        '-i', imagePaths[i],
        '-vf', `scale=2200:-1,zoompan=z='min(zoom+0.0006,1.15)':d=${frames}:s=1920x1080:fps=${fps},format=yuv420p`,
        '-t', String(duration),
        '-r', String(fps),
        clipPath
      ]);
      clipPaths.push(clipPath);
    }

    // 3. Concat all scene clips into one silent video
    const listFile = path.join(jobDir, 'concat_list.txt');
    fs.writeFileSync(listFile, clipPaths.map(p => `file '${p}'`).join('\n'));
    const combinedVideo = path.join(jobDir, 'combined.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', combinedVideo]);

    // 4. Download narration + music
    const narrationPath = path.join(jobDir, 'narration.mp3');
    await download(narrationUrl, narrationPath);

    let mixedAudioPath = narrationPath;
    if (musicUrl) {
      const musicPath = path.join(jobDir, 'music.mp3');
      await download(musicUrl, musicPath);
      mixedAudioPath = path.join(jobDir, 'mixed_audio.mp3');
      // Narration at full volume, music ducked underneath, both trimmed to the shortest track
      await run('ffmpeg', [
        '-y',
        '-i', narrationPath,
        '-i', musicPath,
        '-filter_complex', '[0:a]volume=1.0[a0];[1:a]volume=0.12[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]',
        '-map', '[aout]',
        mixedAudioPath
      ]);
    }

    // 5. Attach audio to the concatenated video
    let withAudioPath = path.join(jobDir, 'with_audio.mp4');
    await run('ffmpeg', [
      '-y',
      '-i', combinedVideo,
      '-i', mixedAudioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      withAudioPath
    ]);

    // 6. Build the drawtext/subtitle filter chain (branding watermark + CTA + optional captions)
    const filters = [];
    filters.push(
      `drawtext=text='${escapeDrawtext(channelName)}':fontcolor=white@0.85:fontsize=28:box=1:boxcolor=black@0.35:boxborderw=8:x=w-tw-30:y=h-th-30`
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(ctaText)}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.5:boxborderw=14:x=(w-tw)/2:y=h-th-80:enable='between(t,${ctaStartSec},${ctaEndSec})'`
    );

    let captionsFile = null;
    if (captionsSrt) {
      captionsFile = path.join(jobDir, 'captions.srt');
      fs.writeFileSync(captionsFile, captionsSrt);
      filters.push(`subtitles='${captionsFile.replace(/:/g, '\\:')}':force_style='FontSize=20,PrimaryColour=&HFFFFFF&'`);
    }

    const finalPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
    await run('ffmpeg', [
      '-y',
      '-i', withAudioPath,
      '-vf', filters.join(','),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-c:a', 'copy',
      finalPath
    ]);

    // 7. Clean up intermediate files, keep only the final output
    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({ jobId, videoUrl: `${BASE_URL}/output/${jobId}.mp4` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/output', express.static(OUTPUT_DIR));
app.get('/', (req, res) => res.send('Paras render server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render server listening on port ${PORT}`));
