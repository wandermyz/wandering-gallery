import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { ConfigError, defaultConfigPath, loadConfig } from './config.js';
import { Db } from './db.js';
import { Indexer } from './indexer.js';
import { Trash } from './trash.js';

function parseArgs(argv: string[]) {
  const out: { config?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') out.config = argv[++i];
    else if (argv[i].startsWith('--config=')) out.config = argv[i].slice('--config='.length);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config ?? process.env.WANDERING_GALLERY_CONFIG ?? defaultConfigPath();
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`wandering-gallery: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = process.env.WANDERING_GALLERY_WEB ?? path.resolve(here, '..', 'web');
  const db = new Db(path.join(cfg.dataDir, 'gallery.db'));
  // Plain JSON lines to stdout; systemd's journal captures them.
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const indexer = new Indexer(cfg, db, log);
  const trash = new Trash(cfg, db, indexer);
  const server = await buildApp({ cfg, db, indexer, trash, webRoot, logger: log });

  const repaired = await trash.reconcile();
  if (repaired) log.warn({ count: repaired }, 'restored assets left half-trashed by a previous crash');
  await indexer.start();
  const purge = async () => {
    const n = await trash.purgeExpired();
    if (n) server.log.info({ count: n }, 'purged expired trash');
  };
  void purge();
  setInterval(() => void purge(), 3600_000).unref();

  await server.listen({ host: cfg.server.host, port: cfg.server.port });
  server.log.info({ config: configPath, libraries: cfg.libraries.map((l) => l.id), dataDir: cfg.dataDir }, 'wandering-gallery started');

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    server.log.info({ sig }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await server.close().catch(() => {});
    await indexer.stop().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
