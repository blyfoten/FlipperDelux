// Tiny procedural synth for game sound effects — no assets needed.
let ctx = null;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Call once from a user gesture so the AudioContext is allowed to start.
export function unlockAudio() {
  try { ac(); } catch { /* no audio available */ }
}

function blip({ freq = 440, endFreq = null, dur = 0.1, type = 'square', vol = 0.18, delay = 0 }) {
  let c;
  try { c = ac(); } catch { return; }
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.08, vol = 0.15, delay = 0 }) {
  let c;
  try { c = ac(); } catch { return; }
  const t0 = c.currentTime + delay;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const gain = c.createGain();
  gain.gain.setValueAtTime(vol, t0);
  src.connect(gain).connect(c.destination);
  src.start(t0);
}

export const sfx = {
  flip() { blip({ freq: 180, endFreq: 90, dur: 0.06, type: 'square', vol: 0.12 }); },
  bumper() {
    const f = 620 + Math.random() * 300;
    blip({ freq: f, endFreq: f * 1.5, dur: 0.12, type: 'triangle', vol: 0.25 });
    blip({ freq: f * 2, dur: 0.05, type: 'sine', vol: 0.12 });
  },
  sling() { blip({ freq: 320, endFreq: 520, dur: 0.08, type: 'sawtooth', vol: 0.14 }); },
  wall() { noise({ dur: 0.04, vol: 0.05 }); },
  launch() { blip({ freq: 140, endFreq: 900, dur: 0.35, type: 'sawtooth', vol: 0.2 }); },
  drain() { blip({ freq: 400, endFreq: 60, dur: 0.55, type: 'square', vol: 0.2 }); },
  gameOver() {
    [330, 262, 208, 156].forEach((f, i) => blip({ freq: f, dur: 0.22, type: 'square', vol: 0.16, delay: i * 0.18 }));
  },
  newBall() {
    [392, 523, 659].forEach((f, i) => blip({ freq: f, dur: 0.1, type: 'triangle', vol: 0.14, delay: i * 0.09 }));
  },
};
