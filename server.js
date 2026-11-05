const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ---- Secrets (set these as Environment Variables on Render) ----
const DEVICE_KEY = process.env.DEVICE_KEY || 'change-me-device';
const VIEW_KEY   = process.env.VIEW_KEY   || 'change-me-viewer';
if (!process.env.DEVICE_KEY || !process.env.VIEW_KEY) {
  console.warn('WARNING: DEVICE_KEY / VIEW_KEY not set - using insecure defaults!');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 2 * 1024 * 1024 });

// Health check
app.get('/health', (req, res) => res.send('ok'));

// Web Stream, Gesture Detection & Recording UI Page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>FallGuard AI - Live Stream & Hand Gesture Alert</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      
      <!-- MediaPipe Scripts for Real-time Hand Gesture Detection -->
      <script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" crossorigin="anonymous"></script>
      <script src="https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js" crossorigin="anonymous"></script>
      <script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js" crossorigin="anonymous"></script>

      <style>
        body { background: #0d1117; color: #c9d1d9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; margin: 0; padding: 20px; }
        h2 { color: #58a6ff; margin-bottom: 5px; }
        .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 15px; }
        
        .alert-banner {
          display: none;
          background: #da3633;
          color: #ffffff;
          padding: 12px 20px;
          border-radius: 8px;
          font-size: 18px;
          font-weight: bold;
          margin: 10px auto;
          max-width: 600px;
          box-shadow: 0 0 15px rgba(218, 54, 51, 0.8);
          animation: blink 1s infinite alternate;
        }
        @keyframes blink { from { opacity: 1; } to { opacity: 0.4; } }

        .stream-container { position: relative; display: inline-block; border: 2px solid #30363d; border-radius: 12px; overflow: hidden; background: #161b22; box-shadow: 0px 8px 24px rgba(0, 0, 0, 0.5); }
        canvas { display: block; max-width: 90vw; max-height: 65vh; margin: 0 auto; }
        
        .controls { margin-top: 20px; display: flex; justify-content: center; gap: 15px; flex-wrap: wrap; }
        button { background-color: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 12px 24px; font-size: 15px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; gap: 8px; }
        button:hover { background-color: #30363d; border-color: #8b949e; }
        button.recording { background-color: #da3633; color: #ffffff; border-color: #f85149; animation: pulse 1.5s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(218, 54, 51, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(218, 54, 51, 0); } 100% { box-shadow: 0 0 0 0 rgba(218, 54, 51, 0); } }
        
        .badges { margin-bottom: 15px; }
        .status-badge { display: inline-block; padding: 5px 12px; border-radius: 20px; font-size: 13px; font-weight: bold; margin: 0 4px; }
        .status-online { background: #238636; color: #fff; }
        .status-offline { background: #da3633; color: #fff; }
        .status-wait { background: #9e6a03; color: #fff; }
        .status-gesture { background: #1f6beb; color: #fff; }
        .timer { font-family: monospace; font-size: 16px; color: #f85149; margin-left: 5px; }
      </style>
    </head>
    <body>
      <h2>FallGuard AI - Remote Monitor</h2>
      <div class="subtitle">ESP32-S3 Camera Stream with Real-Time AI Hand Gesture Detection</div>

      <div id="alertBanner" class="alert-banner">🚨 EMERGENCY ALERT: SOS / OPEN PALM GESTURE DETECTED!</div>

      <div class="badges">
        <span id="status" class="status-badge status-wait">Server: connecting...</span>
        <span id="camStatus" class="status-badge status-offline">Camera: unknown</span>
        <span id="gestureBadge" class="status-badge status-gesture">Gesture: None</span>
      </div>

      <div class="stream-container">
        <canvas id="videoCanvas" width="640" height="480"></canvas>
      </div>

      <div class="controls">
        <button id="audioToggleBtn" onclick="toggleAudioAlert()">🔊 Audio Alert: ON</button>
        <button id="snapBtn" onclick="takeSnapshot()">📷 Download Snapshot</button>
        <button id="recBtn" onclick="toggleRecording()">🔴 Start Recording <span id="timer" class="timer" style="display:none;">00:00</span></button>
      </div>

      <script>
        const canvas = document.getElementById('videoCanvas');
        const ctx = canvas.getContext('2d');
        const statusBadge = document.getElementById('status');
        const camBadge = document.getElementById('camStatus');
        const gestureBadge = document.getElementById('gestureBadge');
        const alertBanner = document.getElementById('alertBanner');
        const recBtn = document.getElementById('recBtn');
        const timerSpan = document.getElementById('timer');
        const audioToggleBtn = document.getElementById('audioToggleBtn');

        let mediaRecorder;
        let recordedChunks = [];
        let isRecording = false;
        let recordTimerInterval;
        let recordSeconds = 0;
        let ws = null;
        let audioEnabled = true;
        let audioCtx = null;
        let lastAlertTime = 0;

        function drawPlaceholder(msg) {
          ctx.fillStyle = "#161b22";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#8b949e";
          ctx.font = "18px Segoe UI";
          ctx.textAlign = "center";
          ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
        }
        drawPlaceholder("Waiting for ESP32-S3 Stream...");

        function setServer(text, cls) { statusBadge.textContent = text; statusBadge.className = 'status-badge ' + cls; }
        function setCam(text, cls) { camBadge.textContent = text; camBadge.className = 'status-badge ' + cls; }

        function playBeep() {
          if (!audioEnabled) return;
          try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz Siren frequency
            gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
            
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.4);
          } catch(e) {}
        }

        function toggleAudioAlert() {
          audioEnabled = !audioEnabled;
          audioToggleBtn.textContent = audioEnabled ? "🔊 Audio Alert: ON" : "🔇 Audio Alert: OFF";
        }

        // --- MediaPipe Hands AI Setup ---
        const hands = new Hands({
          locateFile: (file) => \`https://cdn.jsdelivr.net/npm/@mediapipe/hands/\${file}\`
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6
        });

        hands.onResults(onHandResults);

        let currentImage = null;

        function classifyGesture(landmarks) {
          // Landmarks: 4=Thumb tip, 8=Index tip, 12=Middle tip, 16=Ring tip, 20=Pinky tip
          // Joint bases: 2=Thumb IP, 6=Index PIP, 10=Middle PIP, 14=Ring PIP, 18=Pinky PIP
          const indexUp = landmarks[8].y < landmarks[6].y;
          const middleUp = landmarks[12].y < landmarks[10].y;
          const ringUp = landmarks[16].y < landmarks[14].y;
          const pinkyUp = landmarks[20].y < landmarks[18].y;
          const thumbUp = Math.abs(landmarks[4].x - landmarks[17].x) > Math.abs(landmarks[2].x - landmarks[17].x);

          if (indexUp && middleUp && ringUp && pinkyUp) {
            return "SOS_PALM";
          } else if (!indexUp && !middleUp && !ringUp && !pinkyUp) {
            return "CLOSED_FIST";
          } else if (indexUp && middleUp && !ringUp && !pinkyUp) {
            return "PEACE_SIGN";
          } else if (thumbUp && !indexUp && !middleUp && !ringUp && !pinkyUp) {
            return "THUMBS_UP";
          }
          return "HAND_DETECTED";
        }

        function onHandResults(results) {
          if (!currentImage) return;
          
          ctx.save();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);

          if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            for (const landmarks of results.multiHandLandmarks) {
              drawConnectors(ctx, landmarks, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 3 });
              drawLandmarks(ctx, landmarks, { color: '#FF0000', lineWidth: 1, radius: 4 });

              const gesture = classifyGesture(landmarks);
              
              if (gesture === "SOS_PALM") {
                gestureBadge.textContent = "Gesture: 🚨 OPEN PALM (SOS)";
                gestureBadge.className = "status-badge status-offline";
                alertBanner.style.display = "block";
                
                const now = Date.now();
                if (now - lastAlertTime > 500) {
                  playBeep();
                  lastAlertTime = now;
                }
              } else {
                alertBanner.style.display = "none";
                gestureBadge.textContent = "Gesture: " + gesture.replace('_', ' ');
                gestureBadge.className = "status-badge status-gesture";
              }
            }
          } else {
            alertBanner.style.display = "none";
            gestureBadge.textContent = "Gesture: None";
            gestureBadge.className = "status-badge status-gesture";
          }
          ctx.restore();
        }

        function getKey() {
          let k = sessionStorage.getItem('fgkey');
          if (!k) {
            k = prompt('Viewer password:');
            if (k) sessionStorage.setItem('fgkey', k);
          }
          return k || '';
        }

        function connect() {
          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          ws = new WebSocket(protocol + '//' + location.host);
          ws.binaryType = 'arraybuffer';

          ws.onopen = () => {
            ws.send('VIEWER:' + getKey());
            setServer('Server: ONLINE', 'status-online');
          };

          ws.onclose = (ev) => {
            setServer('Server: OFFLINE (retrying...)', 'status-offline');
            setCam('Camera: unknown', 'status-offline');
            if (ev.code === 1008) sessionStorage.removeItem('fgkey');
            setTimeout(connect, 3000);
          };

          ws.onmessage = async (event) => {
            if (typeof event.data === 'string') {
              if (event.data === 'DEVICE:1') {
                setCam('Camera: ONLINE', 'status-online');
              } else if (event.data === 'DEVICE:0') {
                setCam('Camera: OFFLINE', 'status-offline');
                drawPlaceholder('Camera offline - waiting for ESP32-S3...');
              }
              return;
            }
            
            const blob = new Blob([event.data], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = async () => {
              if (canvas.width !== img.width || canvas.height !== img.height) {
                canvas.width = img.width;
                canvas.height = img.height;
              }
              currentImage = img;
              await hands.send({ image: img });
              URL.revokeObjectURL(url);
            };
            img.src = url;
          };
        }
        connect();

        // 1. Snapshot Download Function
        function takeSnapshot() {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const link = document.createElement('a');
          link.download = 'fallguard_snapshot_' + timestamp + '.jpg';
          link.href = canvas.toDataURL('image/jpeg', 0.95);
          link.click();
        }

        // 2. Video Recording Toggle
        function toggleRecording() {
          if (!isRecording) startRecording(); else stopRecording();
        }

        function startRecording() {
          recordedChunks = [];
          const stream = canvas.captureStream(20);
          let options = { mimeType: 'video/webm;codecs=vp9' };
          if (!MediaRecorder.isTypeSupported(options.mimeType)) options = { mimeType: 'video/webm' };
          try {
            mediaRecorder = new MediaRecorder(stream, options);
          } catch (e) {
            alert('MediaRecorder is not supported on this browser.');
            return;
          }
          mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) recordedChunks.push(event.data); };
          mediaRecorder.onstop = saveVideo;
          mediaRecorder.start(100);

          isRecording = true;
          recBtn.classList.add('recording');
          recBtn.childNodes[0].nodeValue = '⏹️ Stop Recording ';
          timerSpan.style.display = 'inline';
          recordSeconds = 0;
          recordTimerInterval = setInterval(() => {
            recordSeconds++;
            const mins = String(Math.floor(recordSeconds / 60)).padStart(2, '0');
            const secs = String(recordSeconds % 60).padStart(2, '0');
            timerSpan.textContent = mins + ':' + secs;
          }, 1000);
        }

        function stopRecording() {
          if (!isRecording) return;
          mediaRecorder.stop();
          isRecording = false;
          clearInterval(recordTimerInterval);
          recBtn.classList.remove('recording');
          recBtn.childNodes[0].nodeValue = '🔴 Start Recording ';
          timerSpan.style.display = 'none';
        }

        function saveVideo() {
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          const url = URL.createObjectURL(blob);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = 'fallguard_video_' + timestamp + '.webm';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        }
      </script>
    </body>
    </html>
  `);
});

// ---------------- WebSocket relay: ESP32-S3 -> Server -> Browsers ----------------
let device = null;
const viewers = new Set();

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function notifyDevice() { send(device, viewers.size > 0 ? 'STREAM:1' : 'STREAM:0'); }
function notifyViewers() { viewers.forEach((v) => send(v, device ? 'DEVICE:1' : 'DEVICE:0')); }

wss.on('connection', (ws) => {
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const authTimer = setTimeout(() => { if (!ws.role) ws.close(1008, 'auth timeout'); }, 10000);

  ws.on('message', (data, isBinary) => {
    if (!ws.role) {
      if (isBinary) return ws.close(1008, 'auth required');
      const msg = data.toString();
      if (msg === 'DEVICE:' + DEVICE_KEY) {
        ws.role = 'device';
        if (device && device !== ws) device.terminate();
        device = ws;
        clearTimeout(authTimer);
        console.log('ESP32 device connected');
        notifyDevice();
        notifyViewers();
      } else if (msg === 'VIEWER:' + VIEW_KEY) {
        ws.role = 'viewer';
        viewers.add(ws);
        clearTimeout(authTimer);
        console.log('Viewer connected (' + viewers.size + ')');
        send(ws, device ? 'DEVICE:1' : 'DEVICE:0');
        notifyDevice();
      } else {
        ws.close(1008, 'bad key');
      }
      return;
    }

    if (ws.role === 'device' && isBinary) {
      viewers.forEach((v) => {
        if (v.readyState === WebSocket.OPEN && v.bufferedAmount < 1024 * 1024) {
          v.send(data, { binary: true });
        }
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws.role === 'viewer') {
      viewers.delete(ws);
      console.log('Viewer left (' + viewers.size + ')');
      notifyDevice();
    } else if (ws.role === 'device' && device === ws) {
      device = null;
      console.log('ESP32 device disconnected');
      notifyViewers();
    }
  });

  ws.on('error', (e) => console.log('ws error:', e.message));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});