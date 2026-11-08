#!/usr/bin/env node
// new Env('酷狗扫码登录')
// cron: @once

const { run } = require('./kugou_sign.js');

run('login', [])
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
