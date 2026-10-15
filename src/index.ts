import { ConfigError, loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";

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

const server = await startHttpServer(config);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
