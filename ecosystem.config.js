// ecosystem.config.js  –  PM2 process manager config
module.exports = {
  apps: [
    {
      name:         'captive-portal',
      script:       './server.js',
      cwd:          '/opt/captive-portal',
      instances:    1,
      autorestart:  true,
      watch:        false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT:     3000
      },
      error_file:  '/var/log/captive-portal/error.log',
      out_file:    '/var/log/captive-portal/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:  true,
      time:        true
    }
  ]
};
