/**
 * PM2 process file for the Express API (+ Socket.io + crons).
 * Keep instances: 1 so cron jobs do not double-fire.
 *
 * Always start from the `current` symlink — never from a release being built.
 */
module.exports = {
  apps: [
    {
      name: 'vbiz-api',
      cwd: '/var/www/vbiz-me-backend/current',
      script: 'dist/server.js',
      interpreter: 'node',
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
