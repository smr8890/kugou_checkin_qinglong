#!/usr/bin/env node
// new Env('酷狗扫码登录')
// cron: 0 0 29 2 *

const { run } = require('./kugou_sign.js');

run('login', [])
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
