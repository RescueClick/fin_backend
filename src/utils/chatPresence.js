/**
 * Shared chat presence (Socket.IO activeUsers + REST heartbeats).
 * Opening the chat UI posts heartbeats so peers show Online even if sockets flake.
 */
const chatHeartbeats = new Map(); // userId -> { at, role }
const HEARTBEAT_TTL_MS = 45000;

export function pruneHeartbeats() {
  const now = Date.now();
  for (const [uid, info] of chatHeartbeats.entries()) {
    if (!info?.at || now - info.at > HEARTBEAT_TTL_MS) {
      chatHeartbeats.delete(uid);
    }
  }
}

export function markHeartbeat(userId, role = "") {
  const uid = String(userId);
  chatHeartbeats.set(uid, { at: Date.now(), role });
  return uid;
}

export function hasActiveHeartbeat(userId) {
  pruneHeartbeats();
  return chatHeartbeats.has(String(userId));
}

export function getOnlineStaffIds(activeUsers) {
  pruneHeartbeats();
  const ids = new Set();

  if (activeUsers) {
    for (const [uid, info] of activeUsers.entries()) {
      if (info?.socketIds?.size > 0) ids.add(String(uid));
    }
  }
  for (const uid of chatHeartbeats.keys()) {
    ids.add(String(uid));
  }
  return Array.from(ids);
}
