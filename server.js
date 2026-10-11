const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Web Stream UI Page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>ESP32-S3 Remote Live Stream</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { background: #121212; color: #fff; text-align: center; font-family: Arial, sans-serif; margin-top: 20px; }
        h2 { color: #00E676; }
        img { max-width: 90%; border: 3px solid #00E676; border-radius: 10px; box-shadow: 0px 4px 15px rgba(0,230,118,0.3); }
      </style>
    </head>
    <body>
      <h2>ESP32-S3 Live Camera Stream</h2>
      <img id="stream" src="" alt="Waiting for camera feed...">
      <script>
        const img = document.getElementById('stream');
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + location.host);
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') {
            const blob = new Blob([event.data], { type: 'image/jpeg' });
            img.src = URL.createObjectURL(blob);
          }
        };
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