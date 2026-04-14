module.exports = {
    apps: [{
        name: 'amazon-scraper',
        script: 'index.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '2G',
        node_args: '--max-old-space-size=2048',
        env: {
            NODE_ENV: 'production'
        },
        error_file: 'logs/pm2-error.log',
        out_file: 'logs/pm2-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }]
};
