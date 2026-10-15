import { ConfigError, loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { cleanupTempFiles } from "./temp-cleanup.js";
import { startTrashPurge } from "./trash-purge.js";

// Never run as root (spec: the container runs as a dedicated DSM user). No override on purpose.
if (process.getuid?.() === 0) {
  console.error(
    "Refusing to run as root (UID 0). Run the container as the dedicated DSM user: set NAS_MCP_UID/NAS_MCP_GID in .env (see README).",
  );
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}. See .env.example.`);
    process.exit(1);
  }
  throw err;
}

const stopPurge = await startTrashPurge(config);
// In the background: on a large Root the walk takes a while; writes wait for it (write lock).
void cleanupTempFiles(config);
const server = await startHttpServer(config);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopPurge();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
