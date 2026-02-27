const path = require('path');

module.exports = {
  apps: [{
    name: 'voice-bot',
    script: 'src/index.js',
    cwd: path.resolve(__dirname),
    node_args: '-r dotenv/config',
  }]
};
