// copilot.js — the CPR Co-Pilot.
//
// WHAT THIS DOES, in plain words:
//   1. Turns on the camera.
//   2. Runs a pose-detection model IN THE BROWSER that finds the rescuer's
//      body points (wrists, shoulders, hips) about 30 times a second.
//   3. Watches the wrists go up and down -> counts compressions -> works out
//      the rate per minute.
//   4. Beats a metronome (sound + vibration + a pulsing ring) at 110/min,
//      which is the rhythm CPR is supposed to be done at.
//   5. Checks whether the hands are roughly over the centre of the chest.
//   6. Sends frames + the live numbers to the hospital screen.
//
// IMPORTANT: the model runs on the phone itself. No internet needed once
// loaded, no video leaves the device unless we choose to send it.

// We load the AI model from YOUR OWN SERVER first, and only fall back to the
// internet if the local copy is missing. That way a bad wifi at the venue
// cannot break the demo. See README-COPILOT.md for the one-time download.
const LOCAL = {
  lib:   '/vendor/mediapipe/vision_bundle.mjs',
  wasm:  '/vendor/mediapipe/wasm',
  model: '/vendor/mediapipe/pose_landmarker_lite.task',
};
const CDN = {
  lib:   'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  wasm:  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

// ---------------------------------------------------------------------------
// Settings you may want to tweak
// ---------------------------------------------------------------------------
const TARGET_BPM      = 110;   // CPR target is 100-120 per minute
const GOOD_MIN        = 100;
const GOOD_MAX        = 120;
const MIN_PEAK_GAP_MS = 250;   // ignore two "pushes" closer than this (noise)
const MIN_AMPLITUDE   = 0.012; // how far the wrist must travel to count as a push
const FRAME_SEND_MS   = 500;   // send a picture to the hospital twice a second

// MediaPipe body-point numbers we care about
const L_SHOULDER = 11, R_SHOULDER = 12;
const L_WRIST    = 15, R_WRIST    = 16;
const L_HIP      = 23, R_HIP      = 24;

// The lines we draw to make a stick figure
const BONES = [
  [11,12],[11,13],[13,15],[12,14],[14,16],
  [11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],
];

// ---------------------------------------------------------------------------
// Grab the page elements once
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const cam   = $('cam');
const cv    = $('skeleton');
const ctx   = cv.getContext('2d');
const ring  = $('ring');
const coach = $('coach');

// ---------------------------------------------------------------------------
// State — everything the app remembers while it runs
// ---------------------------------------------------------------------------
let landmarker   = null;   // the pose model
let running      = false;
let startedAt    = 0;

let wristTrack   = [];     // recent wrist heights, for spotting pushes
let lastPeakAt   = 0;
let peakTimes    = [];     // when each compression happened
let totalPushes  = 0;
let goingDown    = false;
let extremeY     = 0;

let currentRate  = 0;
let handsOk      = null;   // true / false / null (can't tell)
let personSeen   = false;

let audioCtx     = null;
let socket       = null;
let emergencyId  = new URLSearchParams(location.search).get('e') || null;
let lastSpokenAt = 0;

// ---------------------------------------------------------------------------
// STEP 1 — start everything (only after the user taps, browsers demand this)
// ---------------------------------------------------------------------------
$('btnStart').addEventListener('click', async () => {
  $('btnStart').textContent = 'STARTING…';
  try {
    await startCamera();
    await loadModel();
    startAudio();
    connectSocket();

    $('gate').style.display = 'none';
    running   = true;
    startedAt = Date.now();

    startMetronome();
    startFrameSending();
    tick();                       // begins the detection loop
    setInterval(updateTimer, 500);
  } catch (err) {
    $('btnStart').textContent = 'START';
    alert('Could not start: ' + err.message + '\n\nMake sure you allowed camera access and the page is on https:// or localhost.');
  }
});

// ---------------------------------------------------------------------------
// STEP 2 — the camera
// ---------------------------------------------------------------------------
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  cam.srcObject = stream;
  await cam.play();

  // make the drawing canvas match the video size
  const fit = () => { cv.width = cam.videoWidth || 1280; cv.height = cam.videoHeight || 720; };
  fit();
  window.addEventListener('resize', fit);
}

// ---------------------------------------------------------------------------
// STEP 3 — the pose model
// ---------------------------------------------------------------------------
// Is a file actually sitting on our own server? (a quick HEAD request)
async function haveLocal(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch { return false; }
}

async function loadModel() {
  setStatus('LOADING AI');

  // Prefer our own copies; fall back to the internet if they aren't there.
  const useLocal = await haveLocal(LOCAL.model) && await haveLocal(LOCAL.lib);
  const src = useLocal ? LOCAL : CDN;
  console.log('[copilot] loading AI from', useLocal ? 'LOCAL FILES ✓' : 'the internet (CDN)');

  const vision = await import(/* @vite-ignore */ src.lib);
  const { PoseLandmarker, FilesetResolver } = vision;

  const files = await FilesetResolver.forVisionTasks(src.wasm);
  landmarker = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: src.model, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  });

  setStatus(useLocal ? 'LIVE · OFFLINE AI' : 'LIVE');
}

// ---------------------------------------------------------------------------
// STEP 4 — the main loop: look at a frame, find the body, react
// ---------------------------------------------------------------------------
function tick() {
  if (!running) return;

  if (cam.readyState >= 2 && landmarker) {
    const result = landmarker.detectForVideo(cam, performance.now());
    const pose   = result?.landmarks?.[0] || null;

    ctx.clearRect(0, 0, cv.width, cv.height);

    if (pose) {
      personSeen = true;
      drawSkeleton(pose);
      trackCompressions(pose);
      checkHandPosition(pose);
    } else {
      personSeen = false;
      handsOk = null;
    }

    updateCoach();
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// STEP 5 — draw the stick figure on top of the video
// ---------------------------------------------------------------------------
function drawSkeleton(pose) {
  const good = currentRate >= GOOD_MIN && currentRate <= GOOD_MAX;
  const colour = !personSeen ? '#888' : good ? '#4ade80' : '#fbbf24';

  ctx.lineWidth   = 4;
  ctx.strokeStyle = colour;
  ctx.fillStyle   = colour;

  for (const [a, b] of BONES) {
    const p = pose[a], q = pose[b];
    if (!p || !q) continue;
    ctx.beginPath();
    ctx.moveTo(p.x * cv.width, p.y * cv.height);
    ctx.lineTo(q.x * cv.width, q.y * cv.height);
    ctx.stroke();
  }

  // wrists get bigger dots — they are what we are measuring
  for (const i of [L_WRIST, R_WRIST]) {
    const p = pose[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x * cv.width, p.y * cv.height, 11, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// STEP 6 — counting compressions
//
// How it works: we follow the average height of both wrists. When they move
// DOWN and then start coming back UP, that bottom point is one compression.
// We ignore tiny wobbles and anything faster than humanly possible.
// ---------------------------------------------------------------------------
function trackCompressions(pose) {
  const lw = pose[L_WRIST], rw = pose[R_WRIST];
  if (!lw || !rw) return;

  // y is 0 at the top of the picture and 1 at the bottom, so BIGGER y = lower
  const y   = (lw.y + rw.y) / 2;
  const now = performance.now();

  wristTrack.push({ y, t: now });
  if (wristTrack.length > 12) wristTrack.shift();          // keep it short
  if (wristTrack.length < 5) return;

  const smooth = wristTrack.slice(-5).reduce((s, p) => s + p.y, 0) / 5;

  if (extremeY === 0) { extremeY = smooth; return; }

  if (goingDown) {
    if (smooth > extremeY) {
      extremeY = smooth;                                    // still pushing down
    } else if (extremeY - smooth > MIN_AMPLITUDE * 0.5) {
      // we were going down, now coming back up -> that was a compression
      if (now - lastPeakAt > MIN_PEAK_GAP_MS) {
        registerCompression(now);
        lastPeakAt = now;
      }
      goingDown = false;
      extremeY  = smooth;
    }
  } else {
    if (smooth < extremeY) {
      extremeY = smooth;                                    // rising
    } else if (smooth - extremeY > MIN_AMPLITUDE) {
      goingDown = true;                                     // started a new push
      extremeY  = smooth;
    }
  }
}

function registerCompression(now) {
  totalPushes++;
  peakTimes.push(now);
  if (peakTimes.length > 6) peakTimes.shift();

  if (peakTimes.length >= 3) {
    const gaps = [];
    for (let i = 1; i < peakTimes.length; i++) gaps.push(peakTimes[i] - peakTimes[i - 1]);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    currentRate = Math.round(60000 / median);
  }

  $('statCount').textContent = totalPushes + ' compressions';
  $('rate').textContent = currentRate || '--';

  ring.classList.remove('off', 'bad');
  if (currentRate && (currentRate < GOOD_MIN || currentRate > GOOD_MAX)) {
    ring.classList.add(currentRate < 70 || currentRate > 150 ? 'bad' : 'off');
  }
}

// If nobody is pushing for 2 seconds, the rate is stale — clear it.
setInterval(() => {
  if (running && peakTimes.length && performance.now() - peakTimes.at(-1) > 2000) {
    currentRate = 0;
    peakTimes = [];
    $('rate').textContent = '--';
  }
}, 500);

// ---------------------------------------------------------------------------
// STEP 7 — are the hands in the right place?
//
// The right spot is the centre of the chest: roughly between the shoulders,
// about a third of the way down towards the hips.
// ---------------------------------------------------------------------------
function checkHandPosition(pose) {
  const ls = pose[L_SHOULDER], rs = pose[R_SHOULDER];
  const lh = pose[L_HIP],      rh = pose[R_HIP];
  const lw = pose[L_WRIST],    rw = pose[R_WRIST];
  if (!ls || !rs || !lh || !rh || !lw || !rw) { handsOk = null; return; }

  const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid      = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };

  const chest = {
    x: shoulderMid.x + (hipMid.x - shoulderMid.x) * 0.33,
    y: shoulderMid.y + (hipMid.y - shoulderMid.y) * 0.33,
  };
  const hands = { x: (lw.x + rw.x) / 2, y: (lw.y + rw.y) / 2 };

  // scale the allowed error to the person's size, so distance from camera
  // doesn't change the answer
  const torso = Math.hypot(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y) || 0.3;
  const off   = Math.hypot(hands.x - chest.x, hands.y - chest.y) / torso;

  handsOk = off < 0.45;
  $('statHands').textContent = handsOk ? 'hands ✓' : 'hands off-centre';

  // show the target spot so the rescuer can see where to aim
  ctx.beginPath();
  ctx.arc(chest.x * cv.width, chest.y * cv.height, 20, 0, Math.PI * 2);
  ctx.strokeStyle = handsOk ? 'rgba(74,222,128,.9)' : 'rgba(255,77,77,.9)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// STEP 8 — the metronome: ring pulse + click + vibration at 110 per minute
// ---------------------------------------------------------------------------
function startAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function click() {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.28, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + 0.07);
}

function startMetronome() {
  const beatMs = 60000 / TARGET_BPM;
  setInterval(() => {
    if (!running) return;
    ring.classList.add('beat');
    setTimeout(() => ring.classList.remove('beat'), 90);
    click();
    // vibration works on Android; iPhones ignore it — the sound and the ring cover it
    if (navigator.vibrate) navigator.vibrate(38);
  }, beatMs);
}

// ---------------------------------------------------------------------------
// STEP 9 — the ONE line of coaching. Never more than one thing at a time.
// ---------------------------------------------------------------------------
function updateCoach() {
  let msg, tone;

  if (!personSeen) {
    msg = 'Move the phone so it can see you'; tone = 'warn';
  } else if (handsOk === false) {
    msg = 'Move your hands to the centre of the chest'; tone = 'bad';
  } else if (!currentRate) {
    msg = 'Push down hard, in time with the beat'; tone = 'warn';
  } else if (currentRate < GOOD_MIN) {
    msg = 'Push FASTER'; tone = 'bad';
  } else if (currentRate > GOOD_MAX) {
    msg = 'Slow down a little'; tone = 'warn';
  } else {
    msg = 'Good — keep this rhythm'; tone = '';
  }

  if (coach.textContent !== msg) {
    coach.textContent = msg;
    coach.className = tone;
    speak(msg, tone);
  }
}

// say it out loud — hands are busy, eyes are on the patient
function speak(text, tone) {
  const now = Date.now();
  if (now - lastSpokenAt < 3500) return;          // don't nag
  if (tone === '') return;                        // only speak corrections
  lastSpokenAt = now;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.volume = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// STEP 10 — send the picture and the numbers to the hospital
//
// We do NOT use full video streaming. We send one small JPEG twice a second
// over the connection GoldenBay already has. It works on weak networks and it
// is about thirty lines of code instead of a WebRTC server.
// ---------------------------------------------------------------------------
function connectSocket() {
  socket = io();
  socket.on('connect', () => $('statFeed').textContent = 'feed live');
}

function startFrameSending() {
  const grab = document.createElement('canvas');
  grab.width = 480; grab.height = 270;
  const gctx = grab.getContext('2d');

  setInterval(() => {
    if (!running || !socket?.connected) return;
    gctx.drawImage(cam, 0, 0, grab.width, grab.height);
    socket.emit('copilot:frame', {
      emergencyId,
      jpeg: grab.toDataURL('image/jpeg', 0.5),
      stats: {
        rate: currentRate,
        compressions: totalPushes,
        handsOk,
        personSeen,
        elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      },
    });
  }, FRAME_SEND_MS);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function setStatus(t) { $('statusPill').textContent = t; }

function updateTimer() {
  if (!running) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $('timerPill').textContent =
    String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}