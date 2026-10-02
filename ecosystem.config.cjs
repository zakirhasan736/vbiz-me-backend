/**
 * PM2 process file for the Express API (+ Socket.io + crons).
 * Keep instances: 1 so cron jobs do not double-fire.
 *
 * Always start from the `current` symlink — never from a release being built.
 *
 * Runtime uses tsx because the TS ESM sources import without `.js` extensions;
 * plain `node dist/...` cannot resolve those. `yarn build` still runs in deploy
 * for typecheck / asset copy / migrate tooling.
 */
module.exports = {
  apps: [
    {
      // Keep the historical PM2 name so reload replaces the live process.
      name: 'vbizme-api',
      cwd: '/var/www/vbiz-me-backend/current',
      script: 'src/server.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      kill_timeout: 10000,
      listen_timeout: 10000,
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
    },
  ],
}
