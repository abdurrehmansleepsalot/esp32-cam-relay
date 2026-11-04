const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Web Stream & Recording UI Page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>FallGuard AI - Live Stream & Recorder</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { 
          background: #0d1117; 
          color: #c9d1d9; 
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
          text-align: center; 
          margin: 0; 
          padding: 20px; 
        }
        h2 { color: #58a6ff; margin-bottom: 5px; }
        .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 20px; }
        
        .stream-container {
          position: relative;
          display: inline-block;
          border: 2px solid #30363d;
          border-radius: 12px;
          overflow: hidden;
          background: #161b22;
          box-shadow: 0px 8px 24px rgba(0, 0, 0, 0.5);
        }
        
        canvas { 
          display: block; 
          max-width: 90vw; 
          max-height: 65vh; 
          margin: 0 auto; 
        }

        .controls {
          margin-top: 20px;
          display: flex;
          justify-content: center;
          gap: 15px;
          flex-wrap: wrap;
        }

        button {
          background-color: #21262d;
          color: #c9d1d9;
          border: 1px solid #30363d;
          padding: 12px 24px;
          font-size: 15px;
          font-weight: 600;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        button:hover {
          background-color: #30363d;
          border-color: #8b949e;
        }

        button.recording {
          background-color: #da3633;
          color: #ffffff;
          border-color: #f85149;
          animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(218, 54, 51, 0.7); }
          70% { box-shadow: 0 0 0 10px rgba(218, 54, 51, 0); }
          100% { box-shadow: 0 0 0 0 rgba(218, 54, 51, 0); }
        }

        .status-badge {
          display: inline-block;
          padding: 5px 12px;
          border-radius: 20px;
          font-size: 13px;
          font-weight: bold;
          margin-bottom: 15px;
        }
        .status-online { background: #238636; color: #fff; }
        .status-offline { background: #da3633; color: #fff; }
        .timer { font-family: monospace; font-size: 16px; color: #f85149; margin-left: 5px; }
      </style>
    </head>
    <body>
      <h2>FallGuard AI - Remote Monitor</h2>
      <div class="subtitle">ESP32-S3 Live Camera Stream & Incident Recording</div>
      
      <div>
        <span id="status" class="status-badge status-offline">Connecting...</span>
      </div>

      <div class="stream-container">
        <canvas id="videoCanvas" width="640" height="480"></canvas>
      </div>

      <div class="controls">
        <button id="snapBtn" onclick="takeSnapshot()">📷 Download Snapshot</button>
        <button id="recBtn" onclick="toggleRecording()">🔴 Start Recording <span id="timer" class="timer" style="display:none;">00:00</span></button>
      </div>

      <script>
        const canvas = document.getElementById('videoCanvas');
        const ctx = canvas.getContext('2d');
        const statusBadge = document.getElementById('status');
        const recBtn = document.getElementById('recBtn');
        const timerSpan = document.getElementById('timer');

        let mediaRecorder;
        let recordedChunks = [];
        let isRecording = false;
        let recordTimerInterval;
        let recordSeconds = 0;
        let currentBlobUrl = null;

        // Draw initial placeholder
        ctx.fillStyle = "#161b22";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#8b949e";
        ctx.font = "18px Segoe UI";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for ESP32-S3 Stream...", canvas.width / 2, canvas.height / 2);

        // Setup WebSocket Connection
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + location.host);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          statusBadge.textContent = 'ONLINE';
          statusBadge.className = 'status-badge status-online';
        };

        ws.onclose = () => {
          statusBadge.textContent = 'OFFLINE';
          statusBadge.className = 'status-badge status-offline';
        };

        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') {
            const blob = new Blob([event.data], { type: 'image/jpeg' });
            if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
            currentBlobUrl = URL.createObjectURL(blob);
            
            const img = new Image();
            img.onload = () => {
              if (canvas.width !== img.width || canvas.height !== img.height) {
                canvas.width = img.width;
                canvas.height = img.height;
              }
              ctx.drawImage(img, 0, 0);
            };
            img.src = currentBlobUrl;
          }
        };

        // 1. Snapshot Download Function
        function takeSnapshot() {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const link = document.createElement('a');
          link.download = \`fallguard_snapshot_\${timestamp}.jpg\`;
          link.href = canvas.toDataURL('image/jpeg', 0.95);
          link.click();
        }

        // 2. Video Recording Toggle
        function toggleRecording() {
          if (!isRecording) {
            startRecording();
          } else {
            stopRecording();
          }
        }

        function startRecording() {
          recordedChunks = [];
          const stream = canvas.captureStream(20); // 20 FPS stream from canvas

          let options = { mimeType: 'video/webm;codecs=vp9' };
          if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/webm' };
          }

          try {
            mediaRecorder = new MediaRecorder(stream, options);
          } catch (e) {
            alert('MediaRecorder is not supported on this browser.');
            return;
          }

          mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              recordedChunks.push(event.data);
            }
          };

          mediaRecorder.onstop = saveVideo;
          mediaRecorder.start(100); // collect 100ms chunks

          isRecording = true;
          recBtn.classList.add('recording');
          recBtn.childNodes[0].nodeValue = '⏹️ Stop Recording ';
          timerSpan.style.display = 'inline';
          recordSeconds = 0;
          
          recordTimerInterval = setInterval(() => {
            recordSeconds++;
            const mins = String(Math.floor(recordSeconds / 60)).padStart(2, '0');
            const secs = String(recordSeconds % 60).padStart(2, '0');
            timerSpan.textContent = \`\${mins}:\${secs}\`;
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
          a.download = \`fallguard_video_\${timestamp}.webm\`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 100);
        }
      </script>
    </body>
    </html>
  `);
});

// WebSocket Relay: ESP32-S3 -> Server -> Browsers
wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: true });
        }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});