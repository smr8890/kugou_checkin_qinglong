#!/usr/bin/env node
// new Env('酷狗签到')
// cron: 17 7 * * *

'use strict';

/**
 * 酷狗签到（青龙版）
 *
 *  - token 只存青龙环境变量 KUGOU_ACCOUNTS
 *  - 通过青龙内置全局 QLAPI 读写环境变量
 *  - 本地安装固定版本 KuGouMusicApi，并以 inproc 方式调用
 *  - 提供 sign / login / uninstall 三种模式
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const API_REF = 'v1.6.3';
const API_COMMIT = '5d6c9f7b180279c9dd08bc6f7159de52a856d587';
const API_PKG_VERSION = '1.6.3';
const API_ARCHIVE_URL = `https://codeload.github.com/MakcRe/KuGouMusicApi/tar.gz/refs/tags/${API_REF}`;

const ENV_NAME = 'KUGOU_ACCOUNTS';
const ENV_REMARKS = '酷狗账号';

const LOGIN_TIMEOUT = 120; // 秒
const ACCOUNT_DELAY = 3; // 秒
const REFRESH_DAYS = 7;
const BEIJING_OFFSET = 8 * 3600 * 1000;

const LOCK_WAIT_MS = 30 * 1000;
const ENV_LOCK_STALE_MS = 5 * 60 * 1000;
const INSTALL_LOCK_STALE_MS = 20 * 60 * 1000;
const CLEAN_STALE_MS = 24 * 3600 * 1000;

const REQUIRED_API_FILES = [
  'package.json',
  'main.js',
  'app.js',
  'server.js',
  'module/youth_day_vip.js',
  'module/youth_day_vip_upgrade.js',
  'module/login_token.js',
  'module/login_qr_key.js',
  'module/login_qr_create.js',
  'module/login_qr_check.js',
  'module/user_detail.js',
  'module/user_vip_detail.js',
  'util/util.js',
  'util/request.js',
];

const REQUIRED_API_DEPS = ['express', 'axios', 'qrcode'];

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const QL_DIR = process.env.QL_DIR || '/ql';
const DATA_DIR = process.env.QL_DATA_DIR || path.join(QL_DIR, 'data');
const HOME = path.join(DATA_DIR, 'kugouApi');
const RUNTIME_DIR = path.join(HOME, 'runtime');
const API_DIR = path.join(RUNTIME_DIR, 'KuGouMusicApi');
const STATE_FILE = path.join(HOME, 'state.json');
const QR_FILE = path.join(HOME, 'qr.png');
const ENV_LOCK = path.join(HOME, 'env.lock');
const INSTALL_LOCK = path.join(HOME, 'install.lock');

const PLATFORM = String(process.env.KUGOU_PLATFORM || '').trim() === 'lite' ? 'lite' : '';

// ---------------------------------------------------------------------------
// 日志 / 通用工具
// ---------------------------------------------------------------------------

function timestamp() {
  const d = new Date(Date.now() + BEIJING_OFFSET);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function log(...args) {
  console.log(`[酷狗 ${timestamp()}]`, ...args);
}

function warn(...args) {
  console.warn(`[酷狗 ${timestamp()}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskToken(token) {
  const s = String(token || '');
  if (!s) return '(空)';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function bodyMessage(body) {
  if (!body || typeof body !== 'object') return String(body || '');
  const msg = body.error_msg || body.msg || body.error || body.errmsg || body.message || '';
  const text = typeof msg === 'string' ? msg.trim() : String(msg || '');
  if (text) return text;
  if (body.error_code !== undefined && body.error_code !== 0 && body.error_code !== '0') {
    return `错误码 ${body.error_code}`;
  }
  return '';
}

function accountLabel(account) {
  const name = account.name || '未命名';
  return `${name}(${account.userid})`;
}

function todayBeijing() {
  return new Date(Date.now() + BEIJING_OFFSET).toISOString().slice(0, 10);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// 文件工具
// ---------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonFile(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

async function safeRemove(target) {
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    await fsp.unlink(target);
  } else if (stat.isDirectory()) {
    await fsp.rm(target, { recursive: true, force: true });
  } else {
    await fsp.unlink(target);
  }
  return true;
}

function assertInsideHome(target) {
  const rel = path.relative(HOME, path.resolve(target));
  if (rel === '') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝删除 kugouApi 之外的路径：${target}`);
  }
}

// ---------------------------------------------------------------------------
// 设备身份 / state.json
// ---------------------------------------------------------------------------

function randomUpperString(len = 10) {
  const alphabet = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function randomUint64String() {
  return BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString();
}

function defaultState() {
  return {
    api: null,
    device: {
      guid: crypto.randomUUID(),
      dev: randomUpperString(10),
      mac: '02:00:00:00:00:00',
      webgl: randomUint64String(),
    },
  };
}

async function loadState() {
  const raw = await readJsonFile(STATE_FILE, null);
  const state = defaultState();
  if (raw && typeof raw === 'object') {
    if (raw.api && typeof raw.api === 'object') state.api = raw.api;
    if (raw.device && typeof raw.device === 'object') {
      state.device = {
        guid: raw.device.guid || state.device.guid,
        dev: raw.device.dev || state.device.dev,
        mac: raw.device.mac || state.device.mac,
        webgl: raw.device.webgl || state.device.webgl,
      };
    }
  }
  return state;
}

async function saveState(state) {
  await writeJsonAtomic(STATE_FILE, state);
}

// ---------------------------------------------------------------------------
// 命令执行 / 下载 / 解压
// ---------------------------------------------------------------------------

function runCommand(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = {},
    timeoutMs = 0,
    quiet = true,
    maxOutput = 200 * 1024,
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      err.code = err.code || 'ENOENT';
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > maxOutput ? next.slice(-maxOutput) : next;
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        const err = new Error(`${command} 执行超时（${Math.round(timeoutMs / 1000)} 秒）`);
        err.code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        if (!quiet) {
          stdout
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .forEach((line) => log(`  ${line.trim()}`));
        }
        resolve({ stdout, stderr });
        return;
      }
      const tail = `${stderr || stdout}`
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(-30)
        .join('\n');
      const err = new Error(
        `${command} 退出码 ${code}${tail ? `\n${tail}` : ''}`,
      );
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function downloadFile(url, dest) {
  const commonArgs = [
    '-fL',
    '--retry',
    '3',
    '--retry-delay',
    '2',
    '--connect-timeout',
    '15',
    '--max-time',
    '300',
    '-H',
    'User-Agent: qinglong-kugou-sign',
    '-o',
    dest,
    url,
  ];

  try {
    await runCommand('curl', commonArgs, { timeoutMs: 320000 });
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      warn(`curl 下载失败：${err.message.split('\n')[0]}，尝试 wget`);
    }
  }

  try {
    await runCommand('wget', ['-q', '-O', dest, url], { timeoutMs: 320000 });
    return;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('curl 和 wget 均不可用，无法下载 KuGouMusicApi');
    }
    throw new Error(`下载 KuGouMusicApi 失败：${err.message.split('\n')[0]}`);
  }
}

async function extractArchive(archive, targetDir) {
  const tmpDir = path.join(
    RUNTIME_DIR,
    `.extract-${process.pid}-${Date.now()}`,
  );
  await ensureDir(tmpDir);
  try {
    await runCommand('tar', ['-xzf', archive, '-C', tmpDir], {
      timeoutMs: 120000,
    });

    const entries = await fsp.readdir(tmpDir);
    let root = tmpDir;
    if (entries.length === 1) {
      const only = path.join(tmpDir, entries[0]);
      const stat = await fsp.stat(only);
      if (stat.isDirectory()) root = only;
    }

    await ensureDir(targetDir);
    for (const name of await fsp.readdir(root)) {
      await fsp.rename(path.join(root, name), path.join(targetDir, name));
    }
  } finally {
    await safeRemove(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// 锁
// ---------------------------------------------------------------------------

async function acquireLock(lockPath, options = {}) {
  const {
    waitMs = LOCK_WAIT_MS,
    staleMs = ENV_LOCK_STALE_MS,
    label = '锁',
  } = options;
  const startedAt = Date.now();

  for (;;) {
    try {
      await ensureDir(HOME);
      await fsp.mkdir(lockPath);
      await fsp
        .writeFile(path.join(lockPath, 'pid'), String(process.pid), 'utf8')
        .catch(() => {});
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const stat = await fsp.stat(lockPath).catch(() => null);
      const age = stat ? Date.now() - stat.mtimeMs : 0;
      if (stat && age > staleMs) {
        warn(
          `${label}已存在超过 ${Math.round(staleMs / 60000)} 分钟，视为死锁并清理`,
        );
        await safeRemove(lockPath);
        continue;
      }

      if (Date.now() - startedAt > waitMs) {
        throw new Error(
          `${label}被占用，等待超时。请确认没有其他任务正在运行。`,
        );
      }
      await sleep(500);
    }
  }
}

async function releaseLock(lockPath) {
  await safeRemove(lockPath);
}

// ---------------------------------------------------------------------------
// 账号解析 / 合并
// ---------------------------------------------------------------------------

function parseAccounts(value, options = {}) {
  const { onlyEnabled = false } = options;

  if (value === undefined || value === null || String(value).trim() === '') {
    return [];
  }

  let data;
  try {
    data = JSON.parse(value);
  } catch {
    throw new Error(
      'KUGOU_ACCOUNTS JSON 解析失败，请到青龙环境变量中检查格式；脚本不会覆盖它。',
    );
  }

  if (!Array.isArray(data)) {
    throw new Error('KUGOU_ACCOUNTS 必须是 JSON 数组。');
  }

  const map = new Map();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const token = String(item.token || '').trim();
    const userid = String(item.userid || '').trim();
    if (!token || !userid) continue;

    map.set(userid, {
      ...item,
      token,
      userid,
      name: String(item.name || userid),
      enabled: item.enabled !== false,
    });
  }

  let accounts = Array.from(map.values());
  if (onlyEnabled) accounts = accounts.filter((a) => a.enabled !== false);
  return accounts;
}

function readAccounts() {
  return parseAccounts(process.env[ENV_NAME], { onlyEnabled: true });
}

function mergeAccounts(base, updates) {
  const map = new Map();
  for (const account of base) {
    map.set(String(account.userid), { ...account });
  }

  for (const update of updates) {
    if (!update || !update.userid) continue;
    const userid = String(update.userid);
    const next = { ...(map.get(userid) || {}) };

    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) next[key] = value;
    }

    next.userid = userid;
    next.token = String(next.token || '').trim();
    next.enabled = next.enabled !== false;
    next.name = String(next.name || userid);
    map.set(userid, next);
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// QLAPI 环境变量
// ---------------------------------------------------------------------------

function getQLAPI(options = {}) {
  const { needWrite = false, needDelete = false } = options;
  const ql = globalThis.QLAPI;

  if (!ql || typeof ql !== 'object') {
    throw new Error('请在青龙任务中运行本脚本，QLAPI 不可用。');
  }

  const required = ['getEnvs'];
  if (needWrite) required.push('createEnv', 'updateEnv');
  if (needDelete) required.push('deleteEnvs');

  for (const name of required) {
    if (typeof ql[name] !== 'function') {
      throw new Error(
        `当前青龙版本不支持 QLAPI.${name}，请升级青龙（建议 v2.24.0 及以上）。`,
      );
    }
  }

  return ql;
}

async function qlCall(action, promise) {
  let res;
  try {
    res = await promise;
  } catch (err) {
    throw new Error(`${action} 失败：${err && err.message ? err.message : err}`);
  }
  if (!res || Number(res.code) !== 200) {
    throw new Error(
      `${action} 失败：${(res && (res.message || res.msg)) || '返回内容异常'}`,
    );
  }
  return res;
}

async function findAccountsEnv(ql) {
  const res = await qlCall(
    'QLAPI.getEnvs',
    ql.getEnvs({ searchValue: ENV_NAME }),
  );
  const list = Array.isArray(res.data) ? res.data : [];
  return list.find((item) => item && item.name === ENV_NAME) || null;
}

async function saveAccounts(updates) {
  const ql = getQLAPI({ needWrite: true });
  await ensureDir(HOME);

  const lock = await acquireLock(ENV_LOCK, {
    waitMs: LOCK_WAIT_MS,
    staleMs: ENV_LOCK_STALE_MS,
    label: '环境变量写回锁',
  });

  try {
    // 锁内重新读取，避免覆盖同时新增的账号
    const env = await findAccountsEnv(ql);
    let latest = [];
    if (env) {
      latest = parseAccounts(env.value);
      if (env.status === 1 && typeof ql.enableEnvs === 'function') {
        await qlCall('QLAPI.enableEnvs', ql.enableEnvs({ ids: [env.id] }));
        log('KUGOU_ACCOUNTS 之前被禁用，已自动启用');
      }
    }

    const merged = mergeAccounts(latest, updates);
    const value = JSON.stringify(merged);

    if (env) {
      await qlCall(
        'QLAPI.updateEnv',
        ql.updateEnv({
          env: {
            id: env.id,
            name: ENV_NAME,
            value,
            remarks: env.remarks || ENV_REMARKS,
          },
        }),
      );
      log(`已写回 KUGOU_ACCOUNTS（${merged.length} 个账号）`);
    } else {
      await qlCall(
        'QLAPI.createEnv',
        ql.createEnv({
          envs: [
            {
              name: ENV_NAME,
              value,
              remarks: ENV_REMARKS,
            },
          ],
        }),
      );
      log(`已创建 KUGOU_ACCOUNTS（${merged.length} 个账号）`);
    }

    process.env[ENV_NAME] = value;
    return merged;
  } finally {
    await releaseLock(ENV_LOCK);
  }
}

// ---------------------------------------------------------------------------
// KuGouMusicApi 安装 / 校验
// ---------------------------------------------------------------------------

async function readPackageJson(dir) {
  return readJsonFile(path.join(dir, 'package.json'), null);
}

async function validateApiDir(dir, options = {}) {
  const { withDeps = true } = options;

  for (const rel of REQUIRED_API_FILES) {
    if (!(await pathExists(path.join(dir, rel)))) {
      return { ok: false, reason: `缺少文件 ${rel}` };
    }
  }

  const pkg = await readPackageJson(dir);
  if (!pkg || pkg.name !== 'kugoumusicapi') {
    return { ok: false, reason: 'package.json 名称不匹配' };
  }
  if (pkg.version !== API_PKG_VERSION) {
    return { ok: false, reason: `版本不匹配（当前 ${pkg.version}）` };
  }

  if (withDeps) {
    for (const name of REQUIRED_API_DEPS) {
      if (!(await pathExists(path.join(dir, 'node_modules', name, 'package.json')))) {
        return { ok: false, reason: `依赖 ${name} 未安装` };
      }
    }
  }

  return { ok: true };
}

async function cleanupRuntime() {
  if (!(await pathExists(RUNTIME_DIR))) return;

  const now = Date.now();
  let entries = [];
  try {
    entries = await fsp.readdir(RUNTIME_DIR);
  } catch {
    return;
  }

  for (const name of entries) {
    const full = path.join(RUNTIME_DIR, name);
    const isTemp = /^\.(staging|previous|extract)-/.test(name);
    const isArchive = /^\.api-.*\.tar\.gz$/.test(name);
    if (!isTemp && !isArchive) continue;

    const stat = await fsp.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > CLEAN_STALE_MS) {
      await safeRemove(full).catch(() => {});
      log(`已清理过期临时文件：${name}`);
    }
  }
}

async function writeApiEnv(dir, device) {
  const lines = [
    `platform='${PLATFORM}'`,
    `KUGOU_API_GUID='${device.guid}'`,
    `KUGOU_API_DEV='${device.dev}'`,
    `KUGOU_API_MAC='${device.mac}'`,
    `KUGOU_API_WEBGL='${device.webgl}'`,
    `KUGOU_API_PROXY=''`,
  ];
  await fsp.writeFile(path.join(dir, '.env'), `${lines.join('\n')}\n`, 'utf8');
}

async function verifyInstalledApi(dir) {
  const script = `
    require.resolve('express');
    require.resolve('axios');
    require.resolve('qrcode');
    require('./main.js');
    console.log('api-ok');
  `;
  const { stdout } = await runCommand(process.execPath, ['-e', script], {
    cwd: dir,
    timeoutMs: 120000,
  });
  if (!stdout.includes('api-ok')) {
    throw new Error('KuGouMusicApi 依赖校验失败');
  }
}

async function switchApiDir(stagingDir) {
  const backupDir = path.join(RUNTIME_DIR, `.previous-${Date.now()}`);
  const hadPrevious = await pathExists(API_DIR);

  if (hadPrevious) {
    await fsp.rename(API_DIR, backupDir);
  }

  try {
    await fsp.rename(stagingDir, API_DIR);
  } catch (err) {
    if (hadPrevious && (await pathExists(backupDir))) {
      await fsp.rename(backupDir, API_DIR).catch(() => {});
    }
    throw err;
  }

  if (hadPrevious) {
    await safeRemove(backupDir).catch(() => {});
  }
}

async function installApi(state) {
  const archive = path.join(
    RUNTIME_DIR,
    `.api-${crypto.randomBytes(4).toString('hex')}.tar.gz`,
  );
  const stagingDir = path.join(
    RUNTIME_DIR,
    `.staging-${process.pid}-${Date.now()}`,
  );
  const npmCache = path.join(process.env.HOME || '/root', '.npm');

  log(`开始安装 KuGouMusicApi ${API_REF} ...`);

  try {
    await ensureDir(RUNTIME_DIR);
    await ensureDir(stagingDir);

    log('下载源码包 ...');
    await downloadFile(API_ARCHIVE_URL, archive);

    log('解压源码包 ...');
    await extractArchive(archive, stagingDir);

    const sourceCheck = await validateApiDir(stagingDir, { withDeps: false });
    if (!sourceCheck.ok) {
      throw new Error(`源码校验失败：${sourceCheck.reason}`);
    }

    log('安装 npm 依赖（registry: npmmirror）...');
    await runCommand(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        '--registry=https://registry.npmmirror.com',
      ],
      {
        cwd: stagingDir,
        timeoutMs: 10 * 60 * 1000,
        env: {
          npm_config_cache: npmCache,
          npm_config_update_notifier: 'false',
        },
      },
    );

    log('校验依赖 ...');
    await verifyInstalledApi(stagingDir);

    log('写入 API 设备配置 ...');
    await writeApiEnv(stagingDir, state.device);

    log('切换到新版本 ...');
    await switchApiDir(stagingDir);

    state.api = {
      ref: API_REF,
      resolvedCommit: API_COMMIT,
      pkgVersion: API_PKG_VERSION,
      installedAt: nowSeconds(),
    };
    await saveState(state);

    log('KuGouMusicApi 安装完成');
  } finally {
    await safeRemove(archive).catch(() => {});
    await safeRemove(stagingDir).catch(() => {});
    await cleanupRuntime().catch(() => {});
  }
}

async function ensureApi() {
  const state = await loadState();
  await ensureDir(RUNTIME_DIR);
  await cleanupRuntime();

  const check = await validateApiDir(API_DIR);
  const recordMatches =
    state.api &&
    state.api.ref === API_REF &&
    state.api.pkgVersion === API_PKG_VERSION;

  if (check.ok && recordMatches) {
    log(`KuGouMusicApi ${API_REF} 已就绪`);
    return state;
  }

  if (check.ok && !recordMatches) {
    log('API 版本记录不一致，准备重新安装');
  } else if (!check.ok) {
    log(`API 运行时不可用（${check.reason}），准备安装`);
  }

  const lock = await acquireLock(INSTALL_LOCK, {
    waitMs: LOCK_WAIT_MS,
    staleMs: INSTALL_LOCK_STALE_MS,
    label: 'API 安装锁',
  });

  try {
    // 双重检查
    const state2 = await loadState();
    const check2 = await validateApiDir(API_DIR);
    const record2 =
      state2.api &&
      state2.api.ref === API_REF &&
      state2.api.pkgVersion === API_PKG_VERSION;
    if (check2.ok && record2) {
      log(`KuGouMusicApi ${API_REF} 已就绪`);
      return state2;
    }

    await installApi(state2);
    return state2;
  } finally {
    await releaseLock(INSTALL_LOCK);
  }
}

// ---------------------------------------------------------------------------
// KuGouMusicApi inproc 客户端
// ---------------------------------------------------------------------------

function prepareApiEnv(device) {
  process.env.platform = PLATFORM;
  process.env.KUGOU_API_GUID = device.guid;
  process.env.KUGOU_API_DEV = device.dev;
  process.env.KUGOU_API_MAC = device.mac;
  process.env.KUGOU_API_WEBGL = device.webgl;
  process.env.KUGOU_API_PROXY =
    process.env.KUGOU_API_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    '';
}

function loadApi() {
  const mainPath = path.join(API_DIR, 'main.js');
  const utilPath = path.join(API_DIR, 'util', 'util.js');

  const util = require(utilPath);
  const api = require(mainPath);

  const needed = [
    'login_qr_key',
    'login_qr_create',
    'login_qr_check',
    'login_token',
    'user_detail',
    'youth_day_vip',
    'youth_day_vip_upgrade',
    'user_vip_detail',
  ];
  const missing = needed.filter((name) => typeof api[name] !== 'function');
  if (missing.length) {
    throw new Error(
      `KuGouMusicApi 缺少接口：${missing.join(', ')}，请重新运行登录任务以重装 API。`,
    );
  }

  return { api, util };
}

function buildDeviceCookie(device, util) {
  const guidHash = util.isUUIDv4(device.guid)
    ? crypto.createHash('md5').update(device.guid).digest('hex')
    : device.guid;

  return {
    KUGOU_API_PLATFORM: PLATFORM,
    KUGOU_API_GUID: guidHash,
    KUGOU_API_MID: util.calculateMid(guidHash),
    KUGOU_API_DEV: device.dev,
    KUGOU_API_MAC: device.mac,
    KUGOU_API_WEBGL: device.webgl,
  };
}

function buildCookie(account, device, util) {
  const cookie = buildDeviceCookie(device, util);
  cookie.token = account.token;
  cookie.userid = String(account.userid);
  cookie.t1 = account.t1 || '';
  cookie.dfid = account.dfid || '-';
  return cookie;
}

function normalizeResponse(res) {
  const rawBody = res && res.body !== undefined ? res.body : res;
  const body =
    rawBody && typeof rawBody === 'object'
      ? rawBody
      : { status: 0, msg: String(rawBody || '') };
  const httpStatus = Number(res && res.status) || (body.status === 1 ? 200 : 502);
  return {
    httpStatus,
    body,
    headers: (res && res.headers) || {},
    cookie: (res && Array.isArray(res.cookie) && res.cookie) || [],
  };
}

function isRiskControl(norm) {
  return Boolean(norm.headers['ssa-code'] || norm.headers['SSA-CODE'] || norm.body.ssaCode);
}

function isRetryable(norm) {
  if (isRiskControl(norm)) return false;

  const msg = norm.body.msg;
  if (msg instanceof Error) return true;

  const text = bodyMessage(norm.body);
  if (/timeout|timedout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|connect/i.test(text)) {
    return true;
  }

  if (norm.httpStatus >= 500) {
    return !text && !norm.body.error_code;
  }

  return false;
}

async function apiCall(fn, name, params, options = {}) {
  const { retry = true } = options;

  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt += 1) {
    try {
      return normalizeResponse(await fn(params));
    } catch (err) {
      const norm = normalizeResponse(err);
      if (attempt === 0 && retry && isRetryable(norm)) {
        warn(`${name} 请求异常，2 秒后重试一次`);
        await sleep(2000);
        continue;
      }
      return norm;
    }
  }

  return { httpStatus: 502, body: { status: 0, msg: '请求失败' }, headers: {}, cookie: [] };
}

// ---------------------------------------------------------------------------
// 登录辅助
// ---------------------------------------------------------------------------

function pickKeyValue(body, keys) {
  for (const key of keys) {
    const value = body && body[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  }
  return '';
}

function extractQrKey(norm) {
  const body = norm.body || {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  return (
    pickKeyValue(data, ['qrcode', 'key', 'qrkey']) ||
    pickKeyValue(body, ['qrcode', 'key', 'qrkey'])
  );
}

function cookieValue(cookies, name) {
  for (const raw of cookies || []) {
    const first = String(raw).split(';')[0];
    const index = first.indexOf('=');
    if (index > 0 && first.slice(0, index).trim() === name) {
      return first.slice(index + 1).trim();
    }
  }
  return '';
}

function wrapBase64Image(value) {
  const text = String(value || '');
  const marker = 'base64,';
  const index = text.indexOf(marker);
  if (index >= 0) return text.slice(index + marker.length);
  return text;
}

function pickNickname(data, depth = 0) {
  if (!data || depth > 4) return '';
  if (Array.isArray(data)) {
    for (const item of data) {
      const name = pickNickname(item, depth + 1);
      if (name) return name;
    }
    return '';
  }
  if (typeof data !== 'object') return '';

  for (const key of ['nickname', 'nick_name', 'nickName', 'username', 'user_name']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  for (const key of ['user_info', 'userInfo', 'base', 'user', 'data']) {
    if (data[key]) {
      const name = pickNickname(data[key], depth + 1);
      if (name) return name;
    }
  }
  return '';
}

const VIP_DATE_KEYS = [
  'vip_end_time',
  'vip_expire_time',
  'vip_enddate',
  'vip_due_date',
  'expire_time',
  'end_time',
  'expired_at',
  'expire_at',
  'due_date',
];

function formatTimestamp(value) {
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(ms + BEIJING_OFFSET);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseVipDate(value) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    if (/^\d{8}$/.test(text)) {
      return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    }
    if (/^\d{10,13}$/.test(text)) return formatTimestamp(Number(text));
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    if (value >= 19000101 && value <= 29991231) {
      const text = String(Math.trunc(value));
      return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    }
    return formatTimestamp(value);
  }

  return null;
}

function findVipExpire(value, depth = 0) {
  if (value === undefined || value === null || depth > 6) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVipExpire(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  for (const key of VIP_DATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = parseVipDate(value[key]);
      if (found) return found;
    }
  }

  for (const child of Object.values(value)) {
    const found = findVipExpire(child, depth + 1);
    if (found) return found;
  }

  return null;
}

function isAlreadyMessage(message, kind) {
  const text = String(message || '');
  if (/已经领取|已领取|领取过|重复领取|already/i.test(text)) return true;
  if (kind === 'upgrade' && /已经升级|已升级|升级过|今日已升级|重复升级|already/i.test(text)) {
    return true;
  }
  return false;
}

function isAuthMessage(message) {
  return /未登录|登录失效|登录已失效|登录态.*失效|token.*(失效|过期|错误|无效)|请.*重新登录|重新扫码/i.test(
    String(message || ''),
  );
}

function redactForLog(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/token|t1|dfid|cookie|password|secret/i.test(key)) {
        out[key] = '***';
      } else {
        out[key] = redactForLog(child, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function logRawResponse(apiName, body) {
  try {
    const text = JSON.stringify(redactForLog(body));
    if (text) log(`  ${apiName} 原始返回：${text.slice(0, 600)}`);
  } catch {
    // 忽略序列化失败
  }
}

function classifySignResult(norm, kind) {
  const message = bodyMessage(norm.body);

  if (Number(norm.body.status) === 1) {
    return {
      ok: true,
      text: kind === 'upgrade' ? '升级成功' : '领取成功',
    };
  }

  if (isRiskControl(norm)) {
    return {
      ok: false,
      text: `触发风控，需要手动验证${message ? `（${message}）` : ''}`,
      risk: true,
    };
  }

  if (isAlreadyMessage(message, kind)) {
    return {
      ok: true,
      text: kind === 'upgrade' ? '今日已升级' : '今日已领取',
    };
  }

  if (isAuthMessage(message)) {
    return {
      ok: false,
      text: 'token 失效，请重新扫码登录',
      auth: true,
    };
  }

  return {
    ok: false,
    text: `失败${message ? `（${message}）` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// 登录流程
// ---------------------------------------------------------------------------

function qrStatusText(status) {
  switch (status) {
    case 0:
      return '二维码已过期';
    case 1:
      return '等待扫码';
    case 2:
      return '已扫码，等待手机确认';
    case 4:
      return '授权成功';
    default:
      return `未知状态 ${status}`;
  }
}

async function login() {
  try {
    getQLAPI({ needWrite: true });
  } catch (err) {
    warn(err.message);
    return 1;
  }

  let existingAccounts = [];
  try {
    existingAccounts = parseAccounts(process.env[ENV_NAME]);
  } catch (err) {
    warn(err.message);
    return 1;
  }

  try {
    const state = await ensureApi();
    prepareApiEnv(state.device);
    const { api, util } = loadApi();
    const deviceCookie = buildDeviceCookie(state.device, util);

    log('获取登录二维码 ...');
    const keyNorm = await apiCall(api.login_qr_key, 'login/qr/key', {
      type: 'web',
      cookie: deviceCookie,
    });
    const key = extractQrKey(keyNorm);
    if (!key) {
      throw new Error(
        `获取二维码 key 失败：${bodyMessage(keyNorm.body) || '返回中没有 qrcode'}`,
      );
    }

    const createNorm = await apiCall(api.login_qr_create, 'login/qr/create', {
      key,
      qrimg: true,
      cookie: deviceCookie,
    });
    const createData =
      createNorm.body && createNorm.body.data ? createNorm.body.data : {};
    const qrUrl =
      createData.url ||
      `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(key)}`;
    const base64 = createData.base64;

    if (base64) {
      await ensureDir(HOME);
      await fsp.writeFile(QR_FILE, Buffer.from(wrapBase64Image(base64), 'base64'));
      log(`二维码已保存：${QR_FILE}`);
    }

    console.log('');
    try {
      const QRCode = require(path.join(API_DIR, 'node_modules', 'qrcode'));
      const terminal = await QRCode.toString(qrUrl, {
        type: 'terminal',
        small: true,
      });
      console.log(terminal);
    } catch {
      log('终端二维码渲染失败，请使用下方链接或 qr.png');
    }
    log(`二维码链接：${qrUrl}`);
    log(`请使用酷狗 App 扫码，最长等待 ${LOGIN_TIMEOUT} 秒 ...`);
    console.log('');

    const deadline = Date.now() + LOGIN_TIMEOUT * 1000;
    let lastStatus = -1;
    let loginData = null;
    let loginCookies = [];

    while (Date.now() < deadline) {
      await sleep(2000);
      const checkNorm = await apiCall(
        api.login_qr_check,
        'login/qr/check',
        { key, cookie: deviceCookie },
        { retry: false },
      );
      const data =
        checkNorm.body && checkNorm.body.data && typeof checkNorm.body.data === 'object'
          ? checkNorm.body.data
          : {};
      const status = Number(data.status);

      if (status !== lastStatus) {
        log(`扫码状态：${qrStatusText(status)}`);
        lastStatus = status;
      }

      if (status === 4) {
        loginData = data;
        loginCookies = checkNorm.cookie;
        break;
      }

      if (status === 0) {
        throw new Error('二维码已过期，请重新运行登录任务。');
      }

      if (checkNorm.body.status === 0 && !checkNorm.body.data) {
        const message = bodyMessage(checkNorm.body);
        if (/过期|expire/i.test(message)) {
          throw new Error('二维码已过期，请重新运行登录任务。');
        }
        warn(`查询扫码状态失败：${message || '未知错误'}`);
      }
    }

    if (!loginData) {
      throw new Error('等待扫码超时，请重新运行登录任务。');
    }

    const userid = String(loginData.userid || cookieValue(loginCookies, 'userid') || '');
    const token = String(loginData.token || cookieValue(loginCookies, 'token') || '');
    if (!userid || !token) {
      throw new Error('扫码成功但未获取到 token/userid，请重新运行登录任务。');
    }

    const tempAccount = {
      token,
      userid,
      t1: loginData.t1 || '',
      dfid: loginData.dfid || '',
    };
    let nickname = '';
    try {
      const detailNorm = await apiCall(api.user_detail, 'user/detail', {
        token: tempAccount.token,
        userid: tempAccount.userid,
        cookie: buildCookie(tempAccount, state.device, util),
      });
      if (detailNorm.body.status === 1) {
        nickname = pickNickname(detailNorm.body.data);
      }
    } catch {
      // 昵称获取失败不影响登录
    }

    const previous = existingAccounts.find((item) => item.userid === userid);
    const account = {
      name: nickname || (previous && previous.name) || userid,
      token,
      userid,
      enabled: true,
      t1: loginData.t1 || (previous && previous.t1) || '',
      dfid: loginData.dfid || (previous && previous.dfid) || '',
      vipType:
        loginData.vip_type !== undefined
          ? String(loginData.vip_type)
          : (previous && previous.vipType) || '',
      vipToken:
        loginData.vip_token !== undefined
          ? String(loginData.vip_token)
          : (previous && previous.vipToken) || '',
      lastRefresh: nowSeconds(),
      lastSignDate: (previous && previous.lastSignDate) || '',
    };

    const merged = await saveAccounts([account]);
    log(
      `登录成功：${accountLabel(account)}，token ${maskToken(account.token)}`,
    );
    log(`KUGOU_ACCOUNTS 现有 ${merged.length} 个账号`);
    log('如需继续添加账号，请重新运行「酷狗扫码登录」任务。');
    return 0;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    warn(`登录失败：${message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// 签到流程
// ---------------------------------------------------------------------------

async function refreshAccount(api, util, device, account) {
  const cookie = buildCookie(account, device, util);
  const norm = await apiCall(api.login_token, 'login/token', {
    token: account.token,
    userid: account.userid,
    cookie,
  });

  if (Number(norm.body.status) !== 1) {
    logRawResponse('login/token', norm.body);
    return {
      ok: false,
      message: bodyMessage(norm.body) || '刷新接口未返回成功',
      norm,
    };
  }

  const data = norm.body.data && typeof norm.body.data === 'object' ? norm.body.data : {};

  if (data.token) account.token = String(data.token);
  if (data.t1 !== undefined) account.t1 = String(data.t1);
  if (data.userid) account.userid = String(data.userid);
  if (data.vip_type !== undefined) account.vipType = String(data.vip_type);
  if (data.vip_token !== undefined) account.vipToken = String(data.vip_token);
  account.lastRefresh = nowSeconds();

  log(`token 刷新成功（${maskToken(account.token)}）`);
  return { ok: true, data, norm };
}

async function fetchUserDetail(api, util, device, account) {
  const cookie = buildCookie(account, device, util);
  const norm = await apiCall(api.user_detail, 'user/detail', {
    token: account.token,
    userid: account.userid,
    cookie,
  });

  if (Number(norm.body.status) === 1 && norm.body.data) {
    return { ok: true, data: norm.body.data, norm };
  }
  logRawResponse('user/detail', norm.body);
  return {
    ok: false,
    message: bodyMessage(norm.body) || '账号信息接口未返回成功',
    norm,
  };
}

async function signAccount(api, util, device, account, today, index, total) {
  const result = {
    account,
    ok: false,
    lines: [],
  };

  log(`账号 ${index}/${total}：${accountLabel(account)}`);

  const lastRefresh = Number(account.lastRefresh) || 0;
  const stale = !lastRefresh || nowSeconds() - lastRefresh > REFRESH_DAYS * 86400;

  if (stale) {
    log('token 已超过 7 天未刷新，尝试刷新 ...');
    const refreshed = await refreshAccount(api, util, device, account);
    if (!refreshed.ok) {
      warn(`token 刷新失败，继续使用旧 token：${refreshed.message}`);
    }
  }

  let detail = await fetchUserDetail(api, util, device, account);
  if (!detail.ok) {
    log('账号信息校验失败，强制刷新 token 后重试一次 ...');
    const refreshed = await refreshAccount(api, util, device, account);
    if (refreshed.ok) {
      detail = await fetchUserDetail(api, util, device, account);
    } else {
      warn(`强制刷新 token 失败：${refreshed.message}`);
    }
  }

  if (!detail.ok) {
    result.lines.push('账号状态：token 失效，请重新扫码登录');
    log(result.lines[result.lines.length - 1]);
    return result;
  }

  const nickname = pickNickname(detail.data);
  if (nickname && (!account.name || account.name === account.userid)) {
    account.name = nickname;
  }

  const cookie = buildCookie(account, device, util);

  // 1) 畅听 VIP
  log('领取畅听 VIP ...');
  const vipNorm = await apiCall(api.youth_day_vip, 'youth/day/vip', {
    receive_day: today,
    token: account.token,
    userid: account.userid,
    cookie,
  });
  const vipResult = classifySignResult(vipNorm, 'receive');
  result.lines.push(`畅听 VIP：${vipResult.text}`);
  if (!vipResult.ok) logRawResponse('youth/day/vip', vipNorm.body);

  if (vipResult.ok) {
    account.lastSignDate = today;
  }

  if (vipResult.risk || vipResult.auth) {
    result.lines.push(`概念 VIP：跳过（${vipResult.risk ? '风控' : 'token 失效'}）`);
    result.lines.push('VIP 到期：跳过');
    log(result.lines.slice(-3).join('；'));
    return result;
  }

  // 2) 概念 VIP 升级
  log('升级概念 VIP ...');
  const upgradeNorm = await apiCall(api.youth_day_vip_upgrade, 'youth/day/vip/upgrade', {
    userid: account.userid,
    token: account.token,
    receive_day: today,
    cookie,
  });
  const upgradeResult = classifySignResult(upgradeNorm, 'upgrade');
  result.lines.push(`概念 VIP：${upgradeResult.text}`);
  if (!upgradeResult.ok) logRawResponse('youth/day/vip/upgrade', upgradeNorm.body);

  // 3) VIP 到期时间（仅展示，不影响签到结果）
  log('查询 VIP 到期时间 ...');
  const vipDetailNorm = await apiCall(api.user_vip_detail, 'user/vip/detail', {
    token: account.token,
    userid: account.userid,
    cookie,
  });
  const expire =
    Number(vipDetailNorm.body.status) === 1
      ? findVipExpire(vipDetailNorm.body.data)
      : null;
  if (expire) {
    result.lines.push(`VIP 到期：${expire}`);
  } else if (Number(vipDetailNorm.body.status) !== 1) {
    result.lines.push(
      `VIP 到期：获取失败${bodyMessage(vipDetailNorm.body) ? `（${bodyMessage(vipDetailNorm.body)}）` : ''}`,
    );
  }

  result.ok = vipResult.ok && upgradeResult.ok;

  for (const line of result.lines) log(`  ${line}`);
  return result;
}

function buildSignNotification(today, results, writeBackError) {
  const lines = [`【酷狗签到】${today}`];
  const success = results.filter((item) => item.ok).length;
  const failed = results.length - success;

  results.forEach((item, index) => {
    lines.push('');
    lines.push(`账号 ${index + 1}/${results.length}：${accountLabel(item.account)}`);
    for (const line of item.lines) lines.push(`  ${line}`);
  });

  lines.push('');
  lines.push(`共 ${results.length} 个账号，成功 ${success}，失败 ${failed}`);

  if (writeBackError) {
    lines.push('');
    lines.push(`token 写回环境变量失败：${writeBackError}`);
  }

  return lines.join('\n');
}

async function sign() {
  try {
    getQLAPI({ needWrite: true });
  } catch (err) {
    warn(err.message);
    return 1;
  }

  let accounts;
  try {
    accounts = readAccounts();
  } catch (err) {
    warn(err.message);
    await notify('酷狗签到失败', err.message).catch(() => {});
    return 1;
  }

  if (!accounts.length) {
    log('未找到酷狗账号。');
    log('请到青龙「任务管理」找到「酷狗扫码登录」任务，点击运行并扫码。');
    return 0;
  }

  const today = todayBeijing();
  log(`开始签到，日期：${today}，账号数：${accounts.length}，平台：${PLATFORM || '标准'}`);

  try {
    const state = await ensureApi();
    prepareApiEnv(state.device);
    const { api, util } = loadApi();

    const results = [];
    const pendingUpdates = [];
    let writeBackError = '';

    const flushUpdates = async () => {
      if (!pendingUpdates.length) return;
      const batch = pendingUpdates.splice(0, pendingUpdates.length);
      try {
        await saveAccounts(batch);
        writeBackError = '';
      } catch (err) {
        pendingUpdates.unshift(...batch);
        writeBackError = err && err.message ? err.message : String(err);
        warn(`token 写回环境变量失败：${writeBackError}`);
        warn('本次运行继续使用内存中的新 token，稍后会再次尝试写回。');
      }
    };

    for (let i = 0; i < accounts.length; i += 1) {
      const account = accounts[i];
      try {
        const result = await signAccount(
          api,
          util,
          state.device,
          account,
          today,
          i + 1,
          accounts.length,
        );
        results.push(result);
        pendingUpdates.push(account);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        warn(`账号 ${accountLabel(account)} 处理异常：${message}`);
        results.push({
          account,
          ok: false,
          lines: [`处理异常：${message}`],
        });
        pendingUpdates.push(account);
      }

      // 每个账号结束后立即写回，避免中途退出丢失已刷新的 token
      await flushUpdates();

      if (i < accounts.length - 1) {
        await sleep(ACCOUNT_DELAY * 1000);
      }
    }

    await flushUpdates();
    if (writeBackError) {
      warn('token 最终未能写回环境变量，下次运行可能仍使用旧 token。');
    }

    const success = results.filter((item) => item.ok).length;
    const failed = results.length - success;
    log('');
    log(`签到完成：共 ${results.length} 个账号，成功 ${success}，失败 ${failed}`);

    await notify(
      '酷狗签到',
      buildSignNotification(today, results, writeBackError),
    );
    return 0;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    warn(`签到任务失败：${message}`);
    await notify('酷狗签到失败', message).catch(() => {});
    return 1;
  }
}

// ---------------------------------------------------------------------------
// 卸载清理
// ---------------------------------------------------------------------------

async function deleteAccountsEnv() {
  const ql = getQLAPI({ needDelete: true });
  const env = await findAccountsEnv(ql);
  if (!env) {
    log('KUGOU_ACCOUNTS 不存在，无需删除');
    return;
  }
  await qlCall('QLAPI.deleteEnvs', ql.deleteEnvs({ ids: [env.id] }));
  delete process.env[ENV_NAME];
  log('已删除环境变量 KUGOU_ACCOUNTS');
}

async function uninstall(args = []) {
  const purge = args.includes('--purge');

  log(purge ? '开始彻底卸载（--purge）...' : '开始卸载本地 API 运行时 ...');

  const homeResolved = path.resolve(HOME);
  const expectedHome = path.join(path.resolve(DATA_DIR), 'kugouApi');
  if (homeResolved !== expectedHome) {
    warn(`路径校验失败：${homeResolved} 不是预期的 ${expectedHome}`);
    return 1;
  }

  const homeStat = await fsp.lstat(HOME).catch(() => null);
  if (homeStat && homeStat.isSymbolicLink()) {
    warn(`拒绝处理符号链接目录：${HOME}`);
    return 1;
  }

  // 安装锁：20 分钟内视为正在安装，默认中止
  const installStat = await fsp.lstat(INSTALL_LOCK).catch(() => null);
  if (installStat) {
    const age = Date.now() - installStat.mtimeMs;
    if (age < INSTALL_LOCK_STALE_MS) {
      warn(
        `检测到 install.lock（${Math.round(age / 1000)} 秒前），可能有任务正在安装 API，已中止。`,
      );
      warn('请等待安装结束后再运行卸载任务。');
      return 1;
    }
    warn('install.lock 已超过 20 分钟，视为死锁，继续删除');
  }

  try {
    const targets = [RUNTIME_DIR, INSTALL_LOCK, ENV_LOCK, QR_FILE];
    for (const target of targets) {
      assertInsideHome(target);
      if (await safeRemove(target)) {
        log(`已删除：${target}`);
      }
    }

    if (await pathExists(HOME)) {
      const left = await fsp.readdir(HOME);
      log(`保留内容：${left.length ? left.join(', ') : '(空)'}`);
    }

    let purgeEnvFailed = false;

    if (purge) {
      assertInsideHome(STATE_FILE);
      if (await safeRemove(STATE_FILE)) {
        log(`已删除：${STATE_FILE}`);
      }

      try {
        await deleteAccountsEnv();
      } catch (err) {
        purgeEnvFailed = true;
        warn(`删除 KUGOU_ACCOUNTS 失败：${err.message}`);
        warn('本地 API 与设备身份已清理，请到青龙面板手动删除 KUGOU_ACCOUNTS。');
      }
    } else {
      const kept = [];
      if (await pathExists(STATE_FILE)) kept.push('state.json（设备身份）');
      if (process.env[ENV_NAME]) kept.push('KUGOU_ACCOUNTS（账号）');
      if (kept.length) log(`已保留 ${kept.join(' 和 ')}。`);
      log('如需彻底清理账号与设备身份，请使用 --purge 参数。');
    }

    if (await pathExists(HOME)) {
      const left = await fsp.readdir(HOME);
      if (!left.length) {
        assertInsideHome(HOME);
        await fsp.rmdir(HOME);
        log(`已删除空目录：${HOME}`);
      }
    }

    if (purgeEnvFailed) return 1;

    log('卸载完成。');
    if (!purge) {
      log('提示：青龙删除订阅不会自动删除 /ql/data/kugouApi，请在删除订阅前运行本任务。');
    }
    return 0;
  } catch (err) {
    warn(`卸载失败：${err && err.message ? err.message : err}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

function findSendNotify() {
  const candidates = [
    path.join(__dirname, 'sendNotify.js'),
    path.join(__dirname, '..', 'sendNotify.js'),
    path.join(DATA_DIR, 'scripts', 'sendNotify.js'),
    path.join(DATA_DIR, 'deps', 'sendNotify.js'),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return require(file);
      } catch {
        // 尝试下一个
      }
    }
  }
  return null;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function notify(title, content) {
  // sendNotify 默认会请求 v1.hitokoto.cn 附加“一言”，该请求失败会导致整个通知中断。
  // 未显式配置时默认关闭，避免无关的外部请求影响通知。
  if (!process.env.HITOKOTO) process.env.HITOKOTO = 'false';

  // 只使用青龙自动复制的 sendNotify.js，不再回退 QLAPI.notify
  const mod = findSendNotify();
  const fn =
    typeof mod === 'function'
      ? mod
      : mod && typeof mod.sendNotify === 'function'
        ? mod.sendNotify
        : null;

  if (!fn) {
    log('未找到 sendNotify.js，仅输出日志。');
    return;
  }

  try {
    // 通知失败或未配置渠道时不能阻塞任务
    await withTimeout(
      Promise.resolve().then(() => fn(title, content)),
      30 * 1000,
      'sendNotify 通知',
    );
  } catch (err) {
    warn(`sendNotify 通知失败：${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(mode, args) {
  if (mode === 'login') return login();
  if (mode === 'uninstall') return uninstall(args);
  if (mode === 'sign') return sign();
  warn(`未知模式：${mode}`);
  warn('用法：node kugou_sign.js [sign|login|uninstall] [--purge]');
  return 1;
}

async function run(mode, args = []) {
  try {
    return await main(mode || 'sign', args);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv[2] || 'sign', process.argv.slice(3))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

module.exports = { run };
