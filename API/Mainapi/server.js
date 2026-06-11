const cluster = require('cluster');
const os = require('os');
require('dotenv').config();

// === CLUSTER MODE CONFIGURATION (au tout début pour éviter que le master charge tout) ===
const NUM_WORKERS = parseInt(process.env.NUM_WORKERS) || 6; // 6 coeurs physiques sur le serveur

if (cluster.isPrimary ?? cluster.isMaster) {
  // === MODE MASTER — ne charge RIEN d'autre (pas de MySQL, Redis, Express, etc.) ===
  console.log(`🚀 Master process ${process.pid} démarré en mode cluster`);
  console.log(`📊 Création de ${NUM_WORKERS} workers...`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = cluster.fork();
    console.log(
      `✓ Worker ${worker.process.pid} créé (${i + 1}/${NUM_WORKERS})`,
    );
  }
  // Anti-fork-bomb : limiter les redémarrages rapides
  const workerRestarts = new Map(); // pid -> [timestamps]
  const MAX_RESTARTS = 5;
  const RESTART_WINDOW_MS = 60000; // 1 minute
  let isShuttingDown = false; // Flag pour empêcher le redémarrage des workers pendant le shutdown

  cluster.on('exit', (worker, code, signal) => {
    if (signal) {
      console.warn(`⚠️ Worker ${worker.process.pid} tué par le signal ${signal}`);
    } else if (code !== 0) {
      console.error(`❌ Worker ${worker.process.pid} terminé avec le code ${code}`);
    } else {
      console.log(`ℹ️ Worker ${worker.process.pid} terminé normalement`);
    }

    // Ne pas redémarrer les workers si le master est en cours d'arrêt
    if (isShuttingDown) {
      console.log(`🛑 Shutdown en cours — worker ${worker.process.pid} ne sera pas redémarré`);
      return;
    }

    // Vérifier le taux de redémarrage pour éviter la boucle infinie
    const now = Date.now();
    const restarts = workerRestarts.get('global') || [];
    const recentRestarts = restarts.filter(t => now - t < RESTART_WINDOW_MS);
    recentRestarts.push(now);
    workerRestarts.set('global', recentRestarts);

    if (recentRestarts.length > MAX_RESTARTS) {
      console.error(`🚨 Trop de redémarrages (${recentRestarts.length} en ${RESTART_WINDOW_MS / 1000}s) — arrêt du fork`);
      return;
    }

    console.log(`🔄 Redémarrage d'un nouveau worker...`);
    const newWorker = cluster.fork();
    console.log(`✅ Nouveau worker ${newWorker.process.pid} créé`);
  });

  // Graceful shutdown master
  const shutdownMaster = () => {
    if (isShuttingDown) return; // Guard: SIGINT + SIGTERM peuvent arriver quasi-simultanement
    isShuttingDown = true;
    console.log('\n🛑 Signal de fermeture reçu par le master...');
    console.log('📤 Envoi du signal de fermeture à tous les workers...');
    for (const id in cluster.workers) {
      cluster.workers[id].send('shutdown');
    }
    let workersAlive = Object.keys(cluster.workers).length;
    const checkInterval = setInterval(() => {
      workersAlive = Object.keys(cluster.workers).length;
      if (workersAlive === 0) {
        clearInterval(checkInterval);
        console.log('✅ Tous les workers sont arrêtés. Arrêt du master.');
        process.exit(0);
      }
    }, 100);
    setTimeout(() => {
      console.warn('⚠️ Timeout atteint (30s). Arrêt forcé du master.');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', shutdownMaster);
  process.on('SIGINT', shutdownMaster);

  console.log(`
╔═══════════════════════════════════════════════════════╗
║  🎯 Mode Cluster Actif                                ║
║  👷 Workers: ${NUM_WORKERS.toString().padEnd(42, ' ')}║
║  🔒 Redis Locks: Verrous distribués entre workers    ║
║  ⚛️  Atomic writes: Garantis entre les processus      ║
╚═══════════════════════════════════════════════════════╝
  `);

  // Le master ne fait RIEN d'autre — pas de require express, mysql, redis, etc.
  return;
}

// =============================================================================
// === WORKER PROCESS ONLY (below) =============================================
// =============================================================================

process.env.UV_THREADPOOL_SIZE = 8; // 8 threads libuv par worker (6 workers x 8 = 48 threads total)

const http = require('http');
const { app, appReady } = require('./app');
const { redis } = require('./config/redis');
const { shutdownCycleTLS, refreshProxyScrapeProxies } = require('./utils/proxyManager');
const { getPool } = require('./mysqlPool');

const PORT = 25565;

// ---------------------------------------------------------------------------
// startServer — create HTTP server with retry logic
// ---------------------------------------------------------------------------
const startServer = async (retries = 3) => {
  try {
    await appReady;
  } catch (error) {
    if (retries > 0) {
      console.error(`[BOOTSTRAP] Échec avant listen: ${error.message}`);
      console.log(`Redémarrage... (${retries} restantes)`);
      return setTimeout(() => startServer(retries - 1), 5000);
    }

    console.error('Échec du bootstrap applicatif après plusieurs tentatives');
    process.exit(1);
  }

  try {
    await refreshProxyScrapeProxies({ force: false, silent: false });
  } catch (error) {
    console.warn(`[PROXYSCRAPE] Initialisation incomplete avant listen: ${error.message}`);
  }

  const server = http.createServer(app);

  // Configure Keep-Alive settings
  server.keepAliveTimeout = 65000; // 65 secondes
  server.headersTimeout = 66000;   // 66 secondes
  server.maxRequestsPerSocket = 0; // Illimité
  server.requestTimeout = 300000;  // 5 minutes timeout to prevent hung sockets

  // Backlog increased to 4096 to handle burst connections
  server.listen(PORT, '0.0.0.0', 4096, () => {
    console.log(`Serveur démarré sur le port ${PORT} - Process ${process.pid}`);
    console.log(`Proxy service available at http://localhost:${PORT}/proxy/`);
    console.log(`Keep-Alive configuré: timeout=${server.keepAliveTimeout}ms, max=1000`);
    console.log(`Performance tuning: UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE}, RequestTimeout=${server.requestTimeout}ms`);
  });

  server.on('error', (err) => {
    console.error('Erreur de démarrage:', err);
    if (retries > 0) {
      console.log(`Redémarrage... (${retries} restantes)`);
      setTimeout(() => startServer(retries - 1), 5000);
    } else {
      console.error('Échec du démarrage après plusieurs tentatives');
      process.exit(1);
    }
  });

  return server;
};

// === DÉMARRAGE DU WORKER ===
let activeServer = null;

startServer().then((server) => {
  activeServer = server;
  console.log(`✅ Worker ${process.pid} - Serveur démarré sur le port ${PORT}`);
}).catch((error) => {
  console.error(`❌ Worker ${process.pid} - Échec du démarrage:`, error);
  process.exit(1);
});

// Graceful shutdown worker — cleanup all resources
const { setShuttingDown, isShuttingDown } = require('./utils/shutdownFlag');
let isWorkerShuttingDown = false;

const shutdownWorker = async () => {
  if (isWorkerShuttingDown) return;
  isWorkerShuttingDown = true;
  setShuttingDown();
  console.log(`\n🛑 Worker ${process.pid} - Signal de fermeture reçu...`);

  // 1. Arrêter d'accepter de nouvelles connexions et attendre les requêtes en cours
  if (activeServer) {
    await new Promise((resolve) => {
      // Empêcher les nouvelles connexions keep-alive de prolonger le shutdown
      activeServer.keepAliveTimeout = 1;
      activeServer.close(() => {
        console.log(`✅ Worker ${process.pid} - Serveur HTTP fermé (plus de requêtes en cours)`);
        resolve();
      });

      // Force-close après 15s si des connexions trainent
      setTimeout(() => {
        console.warn(`⚠️ Worker ${process.pid} - Timeout 15s, fermeture forcée des connexions`);
        activeServer.closeAllConnections();
        resolve();
      }, 15000);
    });
  }

  // 2. Cleanup des ressources
  try { await redis.quit(); } catch { /* ignore */ }
  try { await shutdownCycleTLS(); } catch { /* ignore */ }
  try { const pool = getPool(); if (pool) await pool.end(); } catch { /* ignore */ }
  process.exit(0);
};

process.on('SIGTERM', shutdownWorker);
process.on('SIGINT', shutdownWorker);
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdownWorker();
});
