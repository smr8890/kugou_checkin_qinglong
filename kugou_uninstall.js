#!/usr/bin/env node
// new Env('酷狗卸载清理')
// cron: @once

const { run } = require('./kugou_sign.js');

run('uninstall', process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
