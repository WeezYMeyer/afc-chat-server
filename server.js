// African Futures Conference 2026 — live chat server (Socket.IO)
// Deploy on Render as a Web Service:  build = npm install   start = npm start
// Environment variables:
//   MOD_KEY          secret moderator key (required for delete / lock / export)
//   ALLOWED_ORIGINS  comma-separated site origins allowed to connect
//                    default: https://africanfuturesconference.online,https://www.africanfuturesconference.online
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MOD_KEY = process.env.MOD_KEY || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://africanfuturesconference.online,https://www.africanfuturesconference.online')
  .split(',').map(s => s.trim()).filter(Boolean);

// One chat room per stream tab
const ROOMS = {
  'd1-en': 'Day 1 · English',
  'd1-fr': 'Day 1 · Français',
  'd2-en': 'Day 2 · English',
  'd2-fr': 'Day 2 · Français',
  'd2-b1': 'Day 2 · Breakout Room 1',
  'd2-b2': 'Day 2 · Breakout Room 2',
};
const HISTORY = 150;          // messages sent to someone joining a room
const MAX_LEN = 500;          // characters per message
const MIN_GAP_MS = 1500;      // per-user rate limit

const state = {};             // room -> { messages: [], locked: false }
const archive = [];           // every message ever (for CSV export)
for (const r of Object.keys(ROOMS)) state[r] = { messages: [], locked: false };

const app = express();
app.get('/', (_, res) => res.type('text').send('AFC 2026 chat server is running.'));
app.get('/health', (_, res) => res.json({ ok: true, rooms: Object.fromEntries(
  Object.keys(ROOMS).map(r => [r, { messages: state[r].messages.length, online: roomSize(r), locked: state[r].locked }])) }));

// CSV export of all chat messages:  /export.csv?key=MOD_KEY
app.get('/export.csv', (req, res) => {
  if (!MOD_KEY || req.query.key !== MOD_KEY) return res.status(403).send('Forbidden');
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['time_utc', 'room', 'name', 'message', 'host', 'deleted'].join(',')]
    .concat(archive.map(m => [m.ts, ROOMS[m.room], m.name, m.text, m.mod ? 'yes' : '', m.deleted ? 'yes' : ''].map(q).join(',')));
  res.setHeader('Content-Disposition', 'attachment; filename="afc2026-chat.csv"');
  res.type('text/csv').send('﻿' + rows.join('\n'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: (origin, cb) => cb(null, !origin || ORIGINS.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin) || origin === 'null') },
  maxHttpBufferSize: 1e4,
});

function roomSize(r) { return io?.sockets?.adapter?.rooms?.get(r)?.size || 0; }
function clean(s, n) { return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function presence(r) { io.to(r).emit('presence', { room: r, online: roomSize(r) }); }

io.on('connection', socket => {
  const isMod = !!MOD_KEY && socket.handshake.auth?.modKey === MOD_KEY;
  socket.data = { room: null, name: '', last: 0, isMod };
  socket.emit('hello', { isMod, rooms: ROOMS });

  socket.on('join', ({ room, name } = {}) => {
    if (!ROOMS[room]) return;
    const prev = socket.data.room;
    if (prev) { socket.leave(prev); presence(prev); }
    socket.join(room);
    socket.data.room = room;
    if (name) socket.data.name = clean(name, 40);
    socket.emit('history', { room, messages: state[room].messages.filter(m => !m.deleted), locked: state[room].locked });
    presence(room);
  });

  socket.on('name', name => { socket.data.name = clean(name, 40); });

  socket.on('message', (text, ack) => {
    const d = socket.data, r = d.room;
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!r) return reply({ error: 'Not in a room' });
    if (!d.name) return reply({ error: 'Please enter your name first' });
    if (state[r].locked && !d.isMod) return reply({ error: 'Chat is closed at the moment' });
    const now = Date.now();
    if (now - d.last < MIN_GAP_MS && !d.isMod) return reply({ error: 'Slow down a little' });
    const t = clean(text, MAX_LEN);
    if (!t) return reply({ error: 'Empty message' });
    d.last = now;
    const msg = { id: crypto.randomUUID(), room: r, name: d.name, text: t, mod: d.isMod, ts: new Date(now).toISOString() };
    state[r].messages.push(msg);
    if (state[r].messages.length > HISTORY) state[r].messages.shift();
    archive.push(msg);
    io.to(r).emit('message', msg);
    reply({ ok: true });
  });

  // ---- moderator actions ----
  socket.on('delete', id => {
    if (!socket.data.isMod) return;
    for (const r of Object.keys(state)) {
      const m = state[r].messages.find(x => x.id === id);
      if (m) { m.deleted = true; state[r].messages = state[r].messages.filter(x => x.id !== id); io.to(r).emit('deleted', id); }
    }
    const a = archive.find(x => x.id === id); if (a) a.deleted = true;
  });
  socket.on('lock', locked => {
    const r = socket.data.room;
    if (!socket.data.isMod || !r) return;
    state[r].locked = !!locked;
    io.to(r).emit('locked', { room: r, locked: state[r].locked });
  });
  socket.on('clear', () => {
    const r = socket.data.room;
    if (!socket.data.isMod || !r) return;
    state[r].messages.forEach(m => { m.deleted = true; });
    state[r].messages = [];
    io.to(r).emit('cleared', r);
  });

  socket.on('disconnect', () => { if (socket.data.room) presence(socket.data.room); });
});

server.listen(PORT, () => console.log('AFC chat listening on ' + PORT + (MOD_KEY ? '' : ' (WARNING: MOD_KEY not set)')));
