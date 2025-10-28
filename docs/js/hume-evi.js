// docs/js/hume-evi.js
let ws, mediaStream, mediaNode, audioCtx, playing = false;
const HUME_CONFIG_ID = window.HUME_CONFIG_ID || "<your-evi-config-id>";

export async function startHume() {
  if (playing) return;
  // 1) mint a short-lived token from Supabase Edge
  const r = await fetch('/functions/v1/hume-token', { method: 'POST' });
  const { access_token } = await r.json();
  if (!access_token) throw new Error('No access token');

  // 2) open EVI chat websocket (token + config_id)
  ws = new WebSocket(
    `wss://api.hume.ai/v0/evi/chat?access_token=${encodeURIComponent(access_token)}&config_id=${encodeURIComponent(HUME_CONFIG_ID)}`
  );

  // 3) on open: capture mic and stream PCM/opus (SDKs can help, but raw WS works too)
  ws.addEventListener('open', async () => {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioCtx.createMediaStreamSource(mediaStream);
    // …encode audio frames and send over ws per Hume’s chat protocol…
    playing = true;
  });

  // 4) on messages: play assistant audio + read assistant_prosody for UI
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'audio_output') {
      // queue PCM to WebAudio, or use an <audio> with MediaSource
    } else if (msg.type === 'assistant_message') {
      // text tokens (if enabled)
    } else if (msg.type === 'assistant_prosody') {
      // update UI gauges (e.g., valence/energy)
    }
  });

  ws.addEventListener('close', () => cleanup());
  ws.addEventListener('error', () => cleanup());
}

export function stopHume() {
  ws?.close(); cleanup();
}

function cleanup() {
  playing = false;
  mediaStream?.getTracks().forEach(t => t.stop());
  audioCtx?.close();
  ws = undefined; audioCtx = undefined; mediaStream = undefined;
}
