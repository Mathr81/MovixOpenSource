const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export const registerGracefulShutdown = (
  server,
  {
    runtime = process,
    logger = console,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = {},
) => {
  let shuttingDown = false;

  const shutdown = (signal = 'shutdown') => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`[server] ${signal} received, shutting down gracefully.`);

    const forceExitTimer = setTimeout(() => {
      logger.error(`[server] Graceful shutdown timed out after ${timeoutMs}ms.`);
      server.closeAllConnections?.();
      runtime.exit(1);
    }, timeoutMs);
    forceExitTimer.unref?.();

    server.close((error) => {
      clearTimeout(forceExitTimer);

      if (error) {
        logger.error('[server] Failed to close the HTTP server.', error);
        runtime.exit(1);
        return;
      }

      runtime.exit(0);
    });
  };

  runtime.once('SIGTERM', shutdown);
  runtime.once('SIGINT', shutdown);

  return shutdown;
};
