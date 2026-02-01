module.exports = {
  apps: [
    {
      name: "oaiproxy",
      cwd: __dirname,
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      time: true,
      env: {
        NODE_ENV: "production",
        OAIPROXY_DEBUG: "0",
      },
    },
  ],
};

