// Automated verification test of WebSocket signaling between Viewer and Broadcaster
const WebSocket = require('ws');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Allow local self-signed cert for testing

const ROOM_ID = 'TEST-ROOM-' + Date.now();
const WS_URL = 'wss://localhost:3443';

console.log('Testing WebSocket signaling on:', WS_URL, 'Room:', ROOM_ID);

const viewerWs = new WebSocket(WS_URL);
let broadcasterWs = null;

viewerWs.on('open', () => {
  console.log('1. Viewer WebSocket connected.');
  viewerWs.send(JSON.stringify({
    type: 'join',
    role: 'viewer',
    roomId: ROOM_ID
  }));

  // Now connect simulated phone broadcaster
  setTimeout(() => {
    broadcasterWs = new WebSocket(WS_URL);

    broadcasterWs.on('open', () => {
      console.log('2. Broadcaster (Phone) WebSocket connected.');
      broadcasterWs.send(JSON.stringify({
        type: 'join',
        role: 'broadcaster',
        roomId: ROOM_ID
      }));
    });

    broadcasterWs.on('message', (data) => {
      const msg = JSON.parse(data);
      console.log('   Broadcaster received:', msg.type);

      if (msg.type === 'peer-joined' || msg.status === 'connected') {
        console.log('3. Broadcaster sending WebRTC Offer...');
        broadcasterWs.send(JSON.stringify({
          type: 'offer',
          sdp: { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
          roomId: ROOM_ID
        }));
      }

      if (msg.type === 'answer') {
        console.log('5. Broadcaster received WebRTC Answer from Viewer!');
        console.log('6. Testing remote command (Viewer -> Broadcaster: toggle-torch)...');
        viewerWs.send(JSON.stringify({
          type: 'command',
          action: 'toggle-torch',
          roomId: ROOM_ID,
          state: true
        }));
      }

      if (msg.type === 'command' && msg.action === 'toggle-torch') {
        console.log('7. Broadcaster received remote torch command! State:', msg.state);
        console.log('8. Broadcaster sending battery and hardware telemetry...');
        broadcasterWs.send(JSON.stringify({
          type: 'camera-info',
          battery: 92,
          torch: true,
          facingMode: 'environment',
          roomId: ROOM_ID
        }));
      }
    });
  }, 200);
});

viewerWs.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('   Viewer received:', msg.type);

  if (msg.type === 'peer-joined') {
    console.log('   Viewer detected phone broadcaster joined!');
  }

  if (msg.type === 'offer') {
    console.log('4. Viewer received WebRTC Offer, sending Answer...');
    viewerWs.send(JSON.stringify({
      type: 'answer',
      sdp: { type: 'answer', sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
      roomId: ROOM_ID
    }));
  }

  if (msg.type === 'camera-info') {
    console.log('9. Viewer received hardware telemetry from Phone! Battery:', msg.battery + '%', 'Torch:', msg.torch);
    console.log('\n✅ ALL SIGNALING, WEBRTC HANDSHAKE, TELEMETRY AND REMOTE CONTROLS PASSED!\n');
    viewerWs.close();
    broadcasterWs.close();
    process.exit(0);
  }
});
