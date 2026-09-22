// Server-sent events for live collaboration: who is viewing a page, and
// notifications when someone saves it.
const HEARTBEAT_MS = 25000;
const MAX_CONNECTIONS = 500;
const MAX_CONNECTIONS_PER_IP = 20;

function createLiveHub() {
  const rooms = new Map(); // page -> Map(connectionId -> { res, clientId, user })
  const perIp = new Map();
  let total = 0;
  let nextId = 1;

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function presence(page) {
    const room = rooms.get(page);
    if (!room) return [];
    const seen = new Map();
    for (const conn of room.values()) seen.set(conn.clientId, { clientId: conn.clientId, user: conn.user });
    return [...seen.values()];
  }

  function broadcast(page, event, data) {
    const room = rooms.get(page);
    if (!room) return;
    for (const conn of room.values()) send(conn.res, event, data);
  }

  function broadcastPresence(page) {
    broadcast(page, 'presence', { users: presence(page) });
  }

  // Returns false if the connection limit was hit
  function join(req, res, page, { clientId, user }) {
    const ip = req.ip;
    if (total >= MAX_CONNECTIONS || (perIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) return false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');

    const id = nextId++;
    if (!rooms.has(page)) rooms.set(page, new Map());
    rooms.get(page).set(id, { res, clientId, user });
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    total++;
    broadcastPresence(page);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      const room = rooms.get(page);
      if (room) {
        room.delete(id);
        if (room.size === 0) rooms.delete(page);
      }
      const count = (perIp.get(ip) || 1) - 1;
      if (count <= 0) perIp.delete(ip);
      else perIp.set(ip, count);
      total--;
      broadcastPresence(page);
    });
    return true;
  }

  return { join, broadcast, presence };
}

module.exports = { createLiveHub };
