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
for (const r of Object.keys(ROOMS)) state[r] = { messages: [], locked: false, poll: null };
const pollArchive = [];      // every poll ever run (for CSV export)

function publicPoll(p) {
  if (!p) return null;
  const total = p.counts.reduce((a, b) => a + b, 0);
  return { id: p.id, room: p.room, question: p.question, options: p.options, counts: p.counts, total, open: p.open, ts: p.ts };
}

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

// Poll results:  /polls.csv?key=MOD_KEY
app.get('/polls.csv', (req, res) => {
  if (!MOD_KEY || req.query.key !== MOD_KEY) return res.status(403).send('Forbidden');
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['started_utc', 'room', 'question', 'option', 'votes', 'percent', 'total_votes', 'status'].join(',')];
  pollArchive.forEach(p => {
    const total = p.counts.reduce((a, b) => a + b, 0);
    p.options.forEach((o, i) => rows.push([p.ts, ROOMS[p.room], p.question, o, p.counts[i],
      total ? Math.round(p.counts[i] * 1000 / total) / 10 + '%' : '0%', total, p.open ? 'open' : 'closed'].map(q).join(',')));
  });
  res.setHeader('Content-Disposition', 'attachment; filename="afc2026-polls.csv"');
  res.type('text/csv').send('\ufeff' + rows.join('\n'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: (origin, cb) => cb(null, !origin || ORIGINS.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin) || origin === 'null') },
  maxHttpBufferSize: 1e4,
});

function roomSize(r) { return io?.sockets?.adapter?.rooms?.get(r)?.size || 0; }
function clean(s, n) { return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function votedIndex(p, socket) {
  if (!p) return null;
  const k = socket.data && socket.data.voterId;
  if (k && p.voters.has(k)) return p.voters.get(k);
  return p.voters.has(socket.id) ? p.voters.get(socket.id) : null;
}
function presence(r) { io.to(r).emit('presence', { room: r, online: roomSize(r) }); }

io.on('connection', socket => {
  const isMod = !!MOD_KEY && socket.handshake.auth?.modKey === MOD_KEY;
  socket.data = { room: null, name: '', last: 0, isMod };
  socket.emit('hello', { isMod, rooms: ROOMS });

  socket.on('join', ({ room, name, voterId } = {}) => {
    if (voterId) socket.data.voterId = clean(voterId, 64);
    if (!ROOMS[room]) return;
    const prev = socket.data.room;
    if (prev) { socket.leave(prev); presence(prev); }
    socket.join(room);
    socket.data.room = room;
    if (name) socket.data.name = clean(name, 40);
    socket.emit('history', { room, messages: state[room].messages.filter(m => !m.deleted), locked: state[room].locked });
    socket.emit('poll', { room, poll: publicPoll(state[room].poll), voted: votedIndex(state[room].poll, socket) });
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
  // ---- polls ----
  socket.on('poll:start', ({ question, options, rooms } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!socket.data.isMod) return reply({ error: 'Not allowed' });
    const qn = clean(question, 300);
    const opts = (Array.isArray(options) ? options : []).map(o => clean(o, 120)).filter(Boolean).slice(0, 8);
    if (!qn || opts.length < 2) return reply({ error: 'Add a question and at least 2 options' });
    let targets = (Array.isArray(rooms) && rooms.length ? rooms : [socket.data.room]).filter(r => ROOMS[r]);
    if (!targets.length) return reply({ error: 'No room' });
    const id = crypto.randomUUID();
    targets.forEach(r => {
      const p = { id, room: r, question: qn, options: opts, counts: opts.map(() => 0), voters: new Map(), open: true, ts: new Date().toISOString() };
      state[r].poll = p;
      pollArchive.push(p);
      io.to(r).emit('poll', { room: r, poll: publicPoll(p), voted: null });
    });
    reply({ ok: true, rooms: targets.length });
  });
  socket.on('poll:vote', ({ id, index, voterId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const r = socket.data.room; const p = r && state[r].poll;
    if (!p || p.id !== id) return reply({ error: 'This poll has ended' });
    if (!p.open) return reply({ error: 'Voting is closed' });
    const i = Number(index);
    if (!(i >= 0 && i < p.options.length)) return reply({ error: 'Invalid option' });
    const key = clean(voterId, 64) || socket.id;
    if (p.voters.has(key) || p.voters.has(socket.id)) return reply({ error: 'You have already voted', voted: p.voters.get(key) ?? p.voters.get(socket.id) });
    p.voters.set(key, i); p.voters.set(socket.id, i);
    p.counts[i]++;
    socket.data.voterId = key;
    reply({ ok: true, voted: i });
    io.to(r).emit('poll:update', { room: r, poll: publicPoll(p) });
  });
  socket.on('poll:close', ({ rooms } = {}) => {
    if (!socket.data.isMod) return;
    const targets = (Array.isArray(rooms) && rooms.length ? rooms : [socket.data.room]).filter(r => ROOMS[r]);
    targets.forEach(r => { const p = state[r].poll; if (p) { p.open = false; io.to(r).emit('poll:update', { room: r, poll: publicPoll(p) }); } });
  });
  socket.on('poll:remove', ({ rooms } = {}) => {
    if (!socket.data.isMod) return;
    const targets = (Array.isArray(rooms) && rooms.length ? rooms : [socket.data.room]).filter(r => ROOMS[r]);
    targets.forEach(r => { if (state[r].poll) { state[r].poll.open = false; state[r].poll = null; io.to(r).emit('poll', { room: r, poll: null, voted: null }); } });
  });
  socket.on('poll:hello', ({ voterId } = {}) => {
    socket.data.voterId = clean(voterId, 64);
    const r = socket.data.room;
    if (r) socket.emit('poll', { room: r, poll: publicPoll(state[r].poll), voted: votedIndex(state[r].poll, socket) });
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
