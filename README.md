# AFC 2026 live chat server

Small Socket.IO chat server for the livestream pages on africanfuturesconference.online.
One chat room per stream tab: Day 1 EN/FR, Day 2 EN/FR, Day 2 Breakout Room 1 and 2.

## Deploy on Render

1. Create a new GitHub repo (e.g. `afc-chat-server`) and upload these files: `package.json`, `server.js`, `README.md`, `.gitignore`.
2. In Render: **New > Web Service** > connect that repo.
   - Name: `afc-chat` (gives https://afc-chat.onrender.com)
   - Runtime: Node · Build command: `npm install` · Start command: `npm start`
   - Instance type: **Starter** for the event days (Free sleeps after 15 min idle and loses chat history when it sleeps)
3. Environment variables:
   - `MOD_KEY` = a long secret word (moderator key)
   - `ALLOWED_ORIGINS` = `https://africanfuturesconference.online,https://www.africanfuturesconference.online`
4. Deploy, then open https://afc-chat.onrender.com/health. You should see `{"ok":true,...}`.

If Render gives a different URL, change `CHAT_SERVER` near the bottom of `day1-live.html` and `day2-live.html`.

## Moderating

Open the live page with `?mod=YOUR_MOD_KEY`, e.g.
`https://africanfuturesconference.online/day1-live.html?mod=YOUR_MOD_KEY`

- × next to a message deletes it for everyone
- **Close chat / Open chat** stops or allows new messages in that room
- **Clear room** removes all messages in that room
- **Export CSV** downloads every message from all rooms (do this at the end of each day; messages are kept in memory and are lost on restart/redeploy)

Host messages show a green HOST badge. Never share the `?mod=` link publicly.

## Limits

- 500 characters per message, one message every 1.5 seconds per person
- New joiners see the last 150 messages of the room
