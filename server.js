/**
 * LE CASSE DU MUSÉE — Serveur autoritaire (Node.js + Socket.io)
 * 2 joueurs max : 1er = Voleur (cyan), 2e = Gardien (rouge/ambre)
 * 30 ticks/seconde, chronomètre 5:00, 3 œuvres, piège laser, duel de réflexes.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TICK_MS = 1000 / 30;
const GAME_DURATION = 300; // 5 minutes
const WORLD = { w: 1600, h: 1000 };

// ---------------------------------------------------------------------------
// CARTE DU MUSÉE (définie côté serveur — source de vérité)
// ---------------------------------------------------------------------------
const WALLS = [
  // Bordures extérieures (épaisseur 40)
  { x: 0, y: 0, w: 1600, h: 40 },
  { x: 0, y: 960, w: 1600, h: 40 },
  { x: 0, y: 0, w: 40, h: 1000 },
  { x: 1560, y: 0, w: 40, h: 1000 },
  // Salle Nord-Ouest (œuvre 1) : mur Est + mur Sud avec porte
  { x: 560, y: 40, w: 20, h: 340 },
  { x: 40, y: 380, w: 200, h: 20 },
  { x: 360, y: 380, w: 200, h: 20 },
  // Salle Nord-Est (œuvre 2) : mur Ouest + mur Sud avec porte
  { x: 1040, y: 40, w: 20, h: 340 },
  { x: 1040, y: 380, w: 200, h: 20 },
  { x: 1360, y: 380, w: 200, h: 20 },
  // Salle Sud (œuvre 3) : murs Nord / Ouest / Est avec porte Nord
  { x: 620, y: 620, w: 120, h: 20 },
  { x: 860, y: 620, w: 120, h: 20 },
  { x: 620, y: 620, w: 20, h: 340 },
  { x: 960, y: 620, w: 20, h: 340 },
  // Cloisons décoratives du hall central
  { x: 300, y: 560, w: 140, h: 16 },
  { x: 1160, y: 560, w: 140, h: 16 },
];

// Vitrines : obstacles solides qui bloquent aussi la lumière
const VITRINES = [
  { x: 180, y: 150, w: 90, h: 44 },
  { x: 420, y: 150, w: 90, h: 44 },
  { x: 180, y: 270, w: 90, h: 44 },
  { x: 420, y: 270, w: 90, h: 44 },
  { x: 1180, y: 150, w: 90, h: 44 },
  { x: 1420, y: 150, w: 90, h: 44 },
  { x: 1180, y: 270, w: 90, h: 44 },
  { x: 1420, y: 270, w: 90, h: 44 },
  { x: 700, y: 740, w: 90, h: 44 },
  { x: 810, y: 740, w: 90, h: 44 },
  { x: 700, y: 850, w: 90, h: 44 },
  { x: 810, y: 850, w: 90, h: 44 },
  { x: 750, y: 470, w: 100, h: 40 },
  { x: 180, y: 470, w: 100, h: 40 },
  { x: 1320, y: 470, w: 100, h: 40 },
];

const ARTWORK_POS = [
  { x: 300, y: 210 },
  { x: 1300, y: 210 },
  { x: 800, y: 800 },
];
const BOX_POS = [
  { x: 120, y: 500 },
  { x: 1480, y: 500 },
];
const EXIT_POS = [
  { x: 800, y: 70 },
  { x: 800, y: 930 },
];
const SPAWNS = {
  thief: { x: 140, y: 630 },
  guard: { x: 1460, y: 630 },
};

const OBSTACLES = WALLS.concat(VITRINES);
const FLASH_RANGE = 460;
const FLASH_HALF = 0.48; // ~27.5° de demi-angle
const PLAYER_R = 16;

// ---------------------------------------------------------------------------
// HELPERS GÉOMÉTRIE
// ---------------------------------------------------------------------------
function circleRectResolve(p, r) {
  const cx = Math.max(r.x, Math.min(p.x, r.x + r.w));
  const cy = Math.max(r.y, Math.min(p.y, r.y + r.h));
  const dx = p.x - cx, dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= PLAYER_R * PLAYER_R) return;
  if (d2 === 0) { p.x = r.x - PLAYER_R; return; }
  const d = Math.sqrt(d2);
  p.x = cx + (dx / d) * PLAYER_R;
  p.y = cy + (dy / d) * PLAYER_R;
}
function segIntersectsRect(x1, y1, x2, y2, r) {
  // Test Liang-Barsky : le segment traverse-t-il le rectangle ?
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}
function lineOfSight(x1, y1, x2, y2) {
  for (const r of OBSTACLES) if (segIntersectsRect(x1, y1, x2, y2, r)) return false;
  return true;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}
function isIlluminated(guard, thief, lampOff) {
  if (lampOff) return false;
  const d = Math.hypot(thief.x - guard.x, thief.y - guard.y);
  if (d > FLASH_RANGE) return false;
  const ang = Math.atan2(thief.y - guard.y, thief.x - guard.x);
  if (angleDiff(ang, guard.angle) > FLASH_HALF) return false;
  return lineOfSight(guard.x, guard.y, thief.x, thief.y);
}

// ---------------------------------------------------------------------------
// ÉTAT DE PARTIE
// ---------------------------------------------------------------------------
let players = new Map(); // socketId -> player
let gameState = 'lobby'; // lobby | countdown | playing | duel | over
let timeLeft = GAME_DURATION;
let artworks = [];
let boxes = [];
let laser = null;        // {ax,ay,bx,by,active}
let laserPendingA = null;
let laserRevealedUntil = 0;
let alarmUntil = 0;
let lampOffUntil = 0;
let lampFlickerUntil = 0;
let nextLampFaultAt = 0;
let duel = null;         // {stage, signalAt, signalFiredAt, guardPress, thiefPress, startedAt}
let winner = null;       // {role, reason}
let rematchVotes = new Set();
let lastEvent = null;    // {type, at} pour effets clients (steal, hack, escape...)
let countdownEndAt = 0;
let lastTick = Date.now();

function resetGame(swapRoles) {
  const roles = [...players.values()].map(p => p.role);
  if (swapRoles && roles.length === 2) {
    for (const p of players.values()) p.role = (p.role === 'thief') ? 'guard' : 'thief';
  }
  for (const p of players.values()) {
    const s = SPAWNS[p.role];
    p.x = s.x; p.y = s.y; p.angle = p.role === 'guard' ? Math.PI : 0;
    p.vx = 0; p.vy = 0; p.input = { x: 0, y: 0, run: false, interact: false, angle: p.angle };
    p.dashUntil = 0; p.dashCooldownUntil = 0; p.dashDir = { x: 1, y: 0 };
    p.visibleUntil = 0; p.invulnerableUntil = 0; p.stunUntil = 0; p.running = false;
  }
  artworks = ARTWORK_POS.map((a, i) => ({ id: i, x: a.x, y: a.y, stolen: false, progress: 0 }));
  boxes = BOX_POS.map(b => ({ x: b.x, y: b.y, progress: 0, cooldownUntil: 0 }));
  laser = null; laserPendingA = null; laserRevealedUntil = 0; alarmUntil = 0;
  lampOffUntil = 0; lampFlickerUntil = 0;
  nextLampFaultAt = Date.now() + 20000 + Math.random() * 10000;
  duel = null; winner = null; timeLeft = GAME_DURATION; lastEvent = null;
  rematchVotes = new Set();
}

function startCountdown() {
  resetGame(false);
  gameState = 'countdown';
  countdownEndAt = Date.now() + 3000;
  io.emit('countdown', { n: 3 });
}

function endGame(role, reason) {
  gameState = 'over';
  winner = { role, reason };
  duel = null;
  io.emit('gameOver', winner);
}

function getPlayer(role) {
  for (const p of players.values()) if (p.role === role) return p;
  return null;
}

// ---------------------------------------------------------------------------
// TICK SERVEUR (30 Hz)
// ---------------------------------------------------------------------------
function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  if (gameState === 'countdown') {
    const remain = Math.ceil((countdownEndAt - now) / 1000);
    if (remain !== tick._lastCount && remain > 0) { tick._lastCount = remain; io.emit('countdown', { n: remain }); }
    if (now >= countdownEndAt) { gameState = 'playing'; io.emit('countdown', { n: 0 }); }
  }

  if (gameState === 'playing') {
    timeLeft -= dt;
    if (timeLeft <= 0) { timeLeft = 0; endGame('guard', 'Le chronomètre de 5 minutes est écoulé : le voleur n\'a pas réussi à s\'échapper.'); }

    const thief = getPlayer('thief');
    const guard = getPlayer('guard');
    const lampOff = now < lampOffUntil;

    // Pannes aléatoires de lampe (clignotement ou extinction 1,5 s toutes les 20-30 s)
    if (now >= nextLampFaultAt && !lampOff) {
      if (Math.random() < 0.5) lampFlickerUntil = now + 350;
      else lampOffUntil = now + 1500;
      nextLampFaultAt = now + 20000 + Math.random() * 10000;
    }

    // --- Déplacement des joueurs ---
    for (const p of players.values()) {
      const inp = p.input || { x: 0, y: 0, run: false, interact: false, angle: p.angle };
      p.angle = inp.angle;
      p.running = !!(inp.run && (inp.x !== 0 || inp.y !== 0));
      const stunned = now < p.stunUntil;
      let speed = stunned ? 0 : (p.running ? 335 : 220);
      let mx = inp.x, my = inp.y;
      const len = Math.hypot(mx, my);
      if (len > 0) { mx /= len; my /= len; }

      // Dash du voleur
      if (p.role === 'thief' && now < p.dashUntil) {
        p.x += p.dashDir.x * 920 * dt;
        p.y += p.dashDir.y * 920 * dt;
      } else {
        p.x += mx * speed * dt;
        p.y += my * speed * dt;
      }
      p.x = Math.max(PLAYER_R + 40, Math.min(WORLD.w - PLAYER_R - 40, p.x));
      p.y = Math.max(PLAYER_R + 40, Math.min(WORLD.h - PLAYER_R - 40, p.y));
      for (const r of OBSTACLES) circleRectResolve(p, r);
    }

    if (thief && guard) {
      // --- Interactions du voleur (E maintenu) ---
      const thiefInp = thief.input || {};
      if (thiefInp.interact && now >= thief.stunUntil) {
        for (const a of artworks) {
          if (!a.stolen && Math.hypot(thief.x - a.x, thief.y - a.y) < 58) {
            a.progress += dt / 2.5;
            if (a.progress >= 1) {
              a.stolen = true; a.progress = 0;
              lastEvent = { type: 'steal', at: now, x: a.x, y: a.y };
              const count = artworks.filter(x => x.stolen).length;
              if (count >= 3) lastEvent = { type: 'exitsOpen', at: now };
            }
          } else if (!a.stolen) a.progress = Math.max(0, a.progress - dt * 0.8);
        }
        for (const b of boxes) {
          if (now < b.cooldownUntil) continue;
          if (Math.hypot(thief.x - b.x, thief.y - b.y) < 58) {
            b.progress += dt / 2.0;
            if (b.progress >= 1) {
              b.progress = 0; b.cooldownUntil = now + 10000;
              lampOffUntil = now + 4000; // panne de lampe 4 s
              lastEvent = { type: 'hack', at: now, x: b.x, y: b.y };
            }
          } else b.progress = Math.max(0, b.progress - dt * 0.8);
        }
      } else {
        for (const a of artworks) if (!a.stolen) a.progress = Math.max(0, a.progress - dt * 0.8);
        for (const b of boxes) b.progress = Math.max(0, b.progress - dt * 0.8);
      }

      // --- Piège laser ---
      if (laser && laser.active && now >= thief.invulnerableUntil) {
        if (distToSegment(thief.x, thief.y, laser.ax, laser.ay, laser.bx, laser.by) < 16) {
          laser.active = false;
          laserRevealedUntil = now + 3000;
          alarmUntil = now + 3000;
          lastEvent = { type: 'laser', at: now, x: thief.x, y: thief.y };
        }
      }

      // --- Capture : contact alors que le voleur est éclairé / repéré ---
      const dashVisible = now < thief.visibleUntil;
      const revealed = now < laserRevealedUntil;
      const illuminated = isIlluminated(guard, thief, lampOff);
      const spotted = illuminated || dashVisible || revealed || thief.running;
      const dist = Math.hypot(thief.x - guard.x, thief.y - guard.y);
      if (dist < 38 && spotted && now >= thief.invulnerableUntil && now >= guard.stunUntil) {
        gameState = 'duel';
        duel = {
          stage: 'wait',
          startedAt: now,
          signalAt: now + 900 + Math.random() * 1400,
          signalFiredAt: 0,
          guardPress: null,
          thiefPress: null,
        };
        lastEvent = { type: 'duelStart', at: now };
      }

      // --- Victoire du voleur : sortie ouverte ---
      const exitsUnlocked = artworks.every(a => a.stolen);
      if (exitsUnlocked) {
        for (const e of EXIT_POS) {
          if (Math.hypot(thief.x - e.x, thief.y - e.y) < 52) {
            endGame('thief', 'Les 3 œuvres ont été volées et le voleur a atteint une sortie !');
            break;
          }
        }
      }
    }
  }

  if (gameState === 'duel' && duel) {
    const now2 = Date.now();
    if (duel.stage === 'wait' && now2 >= duel.signalAt) {
      duel.stage = 'signal';
      duel.signalFiredAt = now2;
      lastEvent = { type: 'duelSignal', at: now2 };
    }
    const thief = getPlayer('thief');
    const guard = getPlayer('guard');
    if (duel.guardPress !== null && duel.thiefPress !== null) {
      const diff = Math.abs(duel.thiefPress - duel.guardPress);
      if (diff <= 150) {
        // Évasion du voleur : onde de choc + invulnérabilité 2 s
        if (thief && guard) {
          const dx = thief.x - guard.x, dy = thief.y - guard.y;
          const d = Math.hypot(dx, dy) || 1;
          thief.x += (dx / d) * 90; thief.y += (dy / d) * 90;
          for (const r of OBSTACLES) circleRectResolve(thief, r);
          thief.invulnerableUntil = now2 + 2000;
          guard.stunUntil = now2 + 600;
        }
        lastEvent = { type: 'escape', at: now2, x: thief ? thief.x : 0, y: thief ? thief.y : 0 };
        duel = null; gameState = 'playing';
      } else {
        endGame('guard', 'Le gardien a remporté le Duel de Réflexes : le voleur est capturé !');
      }
    } else if (duel.guardPress !== null && now2 - duel.guardPress > 2000) {
      endGame('guard', 'Le gardien a remporté le Duel de Réflexes : le voleur est capturé !');
    } else if (duel.thiefPress !== null && now2 - duel.thiefPress > 2000) {
      endGame('guard', 'Le gardien a remporté le Duel de Réflexes : le voleur est capturé !');
    } else if (duel.stage === 'signal' && now2 - duel.signalFiredAt > 3000 && duel.guardPress === null && duel.thiefPress === null) {
      endGame('guard', 'Le gardien a remporté le Duel de Réflexes : le voleur est capturé !');
    }
  }

  broadcast(now);
}

function broadcast(now) {
  const lampOff = now < lampOffUntil;
  const flicker = now < lampFlickerUntil;
  const exitsUnlocked = artworks.length === 3 && artworks.every(a => a.stolen);
  const base = {
    state: gameState,
    timeLeft: Math.max(0, timeLeft),
    artworks: artworks.map(a => ({ id: a.id, x: a.x, y: a.y, stolen: a.stolen, progress: a.progress })),
    boxes: boxes.map(b => ({ x: b.x, y: b.y, progress: b.progress, cooling: now < b.cooldownUntil })),
    exitsUnlocked,
    lampOff, flicker,
    alarm: now < alarmUntil,
    laserRevealed: now < laserRevealedUntil,
    duel: duel ? {
      stage: duel.stage,
      signalFiredAt: duel.signalFiredAt,
      guardPress: duel.guardPress,
      thiefPress: duel.thiefPress,
      startedAt: duel.startedAt,
    } : null,
    lastEvent,
    winner,
  };
  for (const [id, p] of players) {
    const thief = getPlayer('thief');
    const guard = getPlayer('guard');
    const playersArr = [...players.values()].map(q => {
      const isThief = q.role === 'thief';
      let visible = true, opacity = 1;
      if (p.role === 'guard' && isThief) {
        const dashV = now < q.visibleUntil;
        const revealed = now < laserRevealedUntil;
        const illum = guard ? isIlluminated(guard, q, lampOff) : false;
        if (dashV || revealed || illum) { visible = true; opacity = 1; }
        else if (q.running) { visible = true; opacity = 0.15; }
        else { visible = false; opacity = 0; }
      }
      return {
        id: q.socketId, role: q.role, x: q.x, y: q.y, angle: q.angle,
        running: q.running, dashing: now < q.dashUntil,
        dashVisible: now < q.visibleUntil,
        invulnerable: now < q.invulnerableUntil,
        stunned: now < q.stunUntil,
        dashReady: now >= q.dashCooldownUntil,
        dashCooldownPct: q.dashCooldownUntil > now ? Math.max(0, Math.min(1, (q.dashCooldownUntil - now) / 5000)) : 0,
        visible, opacity,
      };
    });
    // Le laser est invisible pour le voleur : on ne l'envoie qu'au gardien
    const laserView = (p.role === 'guard')
      ? (laser ? { ...laser } : null)
      : null;
    const pendingView = (p.role === 'guard') ? laserPendingA : null;
    io.to(id).emit('state', { ...base, players: playersArr, laser: laserView, laserPendingA: pendingView, myRole: p.role });
  }
}

setInterval(tick, TICK_MS);

// ---------------------------------------------------------------------------
// SOCKET.IO — Salon 2 joueurs
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  if (players.size >= 2) {
    socket.emit('full', 'Partie complète (2/2 joueurs)');
    setTimeout(() => socket.disconnect(true), 300);
    return;
  }
  const role = players.size === 0 ? 'thief' : 'guard';
  const spawn = SPAWNS[role];
  const player = {
    socketId: socket.id, role,
    x: spawn.x, y: spawn.y, angle: role === 'guard' ? Math.PI : 0,
    input: { x: 0, y: 0, run: false, interact: false, angle: role === 'guard' ? Math.PI : 0 },
    dashUntil: 0, dashCooldownUntil: 0, dashDir: { x: 1, y: 0 },
    visibleUntil: 0, invulnerableUntil: 0, stunUntil: 0, running: false,
  };
  players.set(socket.id, player);

  socket.emit('map', { walls: WALLS, vitrines: VITRINES, world: WORLD, exits: EXIT_POS });
  socket.emit('welcome', { role, message: role === 'thief' ? 'Vous êtes le VOLEUR (cyan).' : 'Vous êtes le GARDIEN (rouge).' });
  emitLobby();

  if (players.size === 2 && (gameState === 'lobby' || gameState === 'over')) {
    startCountdown();
  }

  socket.on('input', (inp) => {
    const p = players.get(socket.id);
    if (!p || !inp) return;
    p.input = {
      x: Math.max(-1, Math.min(1, Number(inp.x) || 0)),
      y: Math.max(-1, Math.min(1, Number(inp.y) || 0)),
      run: !!inp.run,
      interact: !!inp.interact,
      angle: Number(inp.angle) || 0,
    };
    // Dash (voleur, Espace)
    if (inp.dash && p.role === 'thief' && gameState === 'playing') {
      const now = Date.now();
      if (now >= p.dashCooldownUntil && now >= p.dashUntil) {
        let dx = p.input.x, dy = p.input.y;
        if (dx === 0 && dy === 0) { dx = Math.cos(p.input.angle); dy = Math.sin(p.input.angle); }
        const l = Math.hypot(dx, dy) || 1;
        p.dashDir = { x: dx / l, y: dy / l };
        p.dashUntil = now + 180;
        p.dashCooldownUntil = now + 5000;
        p.visibleUntil = now + 180 + 500;
        socket.emit('fx', { type: 'dash' });
      }
    }
  });

  socket.on('laserPoint', (pt) => {
    const p = players.get(socket.id);
    if (!p || p.role !== 'guard' || gameState !== 'playing') return;
    if (laser) return; // 1 seul piège par partie (même une fois déclenché)
    if (!laserPendingA) {
      laserPendingA = { x: Number(pt.x), y: Number(pt.y) };
      socket.emit('fx', { type: 'laserA' });
    } else {
      laser = { ax: laserPendingA.x, ay: laserPendingA.y, bx: Number(pt.x), by: Number(pt.y), active: true };
      laserPendingA = null;
      socket.emit('fx', { type: 'laserB' });
    }
  });

  socket.on('duelPress', () => {
    const p = players.get(socket.id);
    if (!p || gameState !== 'duel' || !duel) return;
    const now = Date.now();
    if (p.role === 'guard' && duel.guardPress === null) duel.guardPress = now;
    if (p.role === 'thief' && duel.thiefPress === null) duel.thiefPress = now;
  });

  socket.on('rematch', () => {
    const p = players.get(socket.id);
    if (!p || gameState !== 'over') return;
    rematchVotes.add(socket.id);
    io.emit('rematchStatus', { votes: rematchVotes.size, total: players.size });
    if (rematchVotes.size >= 2 && players.size === 2) {
      resetGame(true); // inverse les rôles
      startCountdown();
    }
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    if (players.size < 2) {
      gameState = 'lobby';
      duel = null; winner = null; timeLeft = GAME_DURATION;
      laser = null; laserPendingA = null;
      artworks = ARTWORK_POS.map((a, i) => ({ id: i, x: a.x, y: a.y, stolen: false, progress: 0 }));
      boxes = BOX_POS.map(b => ({ x: b.x, y: b.y, progress: 0, cooldownUntil: 0 }));
      io.emit('opponentLeft', 'L\'adversaire a quitté la partie.');
    }
    emitLobby();
  });
});

function emitLobby() {
  io.emit('lobby', {
    count: players.size,
    players: [...players.values()].map(p => ({ role: p.role, id: p.socketId })),
    state: gameState,
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LE CASSE DU MUSÉE — serveur sur http://localhost:${PORT}`);
});
