# 酷狗概念版签到（青龙）

在青龙面板中完成酷狗概念版（`lite`）或标准平台的**扫码登录**与**每日签到**。脚本会在本机自动安装固定版本的 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)，以进程内方式调用，不需要额外部署 API 容器。

## 功能

- 青龙订阅拉库后自动创建 3 个任务：
  - 酷狗扫码登录（含 API 安装）
  - 酷狗概念版签到
  - 酷狗卸载清理（手动运行）
- token 只存青龙环境变量 `KUGOU_ACCOUNTS`，刷新后通过青龙内置 `QLAPI` 写回
- 多账号：每扫一次码添加一个账号，按 `userid` 去重
- 每日领取畅听 VIP、升级概念 VIP、查询 VIP 到期时间
- 支持 `KUGOU_PLATFORM=lite`（概念版）或留空（标准平台）
- 结果通过青龙通知 / `sendNotify` 推送，日志自动脱敏
- 提供 `--purge` 彻底清理账号与设备身份

> **免责声明**：本项目使用非官方接口，仅供个人学习研究使用。请遵守酷狗用户协议，不要公开分享 token，不要用于商业用途。因使用本项目产生的任何后果由使用者自行承担。

## 环境要求

- 青龙 `v2.24.0`（或支持内置 `QLAPI` 的版本）
- 青龙容器内需有 `node`、`npm`、`curl`（或 `wget`）、`tar`
- 无需 git submodule，无需单独的 API 容器

## 青龙拉库

面板订阅填写：

```text
仓库：https://github.com/<你的用户名>/kugou-sign.git
白名单：kugou_sign.js|kugou_login.js|kugou_uninstall.js
黑名单：留空
依赖文件：留空
分支：main
定时规则：0 3 * * *
自动添加任务：开
自动删除任务：开
```

或命令行：

```bash
ql repo https://github.com/<你的用户名>/kugou-sign.git "kugou_sign.js|kugou_login.js|kugou_uninstall.js" "" "" "main"
```

> 定时规则 `0 3 * * *` 是**拉库频率**，不是签到频率。签到任务默认每天 `07:17` 执行。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `KUGOU_ACCOUNTS` | 登录后自动创建 | 账号 JSON 数组，token 唯一存储位置 |
| `KUGOU_PLATFORM` | 否 | 留空为标准平台；填 `lite` 为概念版 |

登录和签到必须使用同一个 `KUGOU_PLATFORM` 值。不同平台的 token 不通用。

`KUGOU_ACCOUNTS` 结构示例：

```json
[
  {
    "name": "主号",
    "token": "xxxxxxxx",
    "userid": "123456789",
    "enabled": true,
    "t1": "",
    "dfid": "",
    "vipType": "",
    "vipToken": "",
    "lastRefresh": 1760000000,
    "lastSignDate": "2026-11-08"
  }
]
```

临时禁用账号：把对应 `"enabled": true` 改为 `false`。彻底删除账号：从数组中移除该项。

## 首次扫码登录

1. 打开青龙「任务管理」
2. 运行「酷狗扫码登录（含 API 安装）」
3. 首次运行会自动下载并安装 KuGouMusicApi（需要几分钟）
4. 日志中会出现终端二维码、二维码链接，并保存到 `/ql/data/kugouApi/qr.png`
5. 使用酷狗 App 扫码并确认
6. 登录成功后，账号自动写入 `KUGOU_ACCOUNTS`
7. 登录完成后建议**禁用登录任务**，避免误触发

## 添加多个账号

再次运行「酷狗扫码登录（含 API 安装）」并扫码即可。脚本按 `userid` 去重：

- 同一账号重复扫码：更新 token
- 不同账号：追加到数组

签到任务按顺序处理所有 `enabled !== false` 的账号，账号间隔 3 秒，不并发。

## 每日签到

「酷狗概念版签到」任务默认每天 `07:17` 执行，依次调用：

- `/user/detail`
- `/youth/day/vip`
- `/youth/day/vip/upgrade`
- `/user/vip/detail`

已领取、已升级会视为成功，不会报错。token 超过 7 天会在签到前自动刷新，刷新结果写回 `KUGOU_ACCOUNTS`。

## 卸载清理

青龙删除订阅时**不会**删除：

```text
/ql/data/kugouApi
KUGOU_ACCOUNTS 环境变量
```

因此删除订阅前请先运行「酷狗卸载清理（手动运行）」。

默认行为：删除 API 运行时、`qr.png`、安装锁，保留：

```text
/ql/data/kugouApi/state.json    # 设备身份，降低重新登录的风控概率
KUGOU_ACCOUNTS                  # 账号
```

彻底清理（同时删除设备身份和 `KUGOU_ACCOUNTS`），把任务命令改成：

```text
task <uniq_path>/kugou_uninstall.js -- --purge
```

注意必须使用 `-- --purge`，`--` 是青龙 `task` 命令区分脚本参数的分隔符。

推荐顺序：

```text
1. 运行「酷狗卸载清理（手动运行）」
2. 确认 /ql/data/kugouApi 已清理
3. 到订阅管理删除本仓库订阅
4. 到任务管理删除残留任务
```

如果已经删除订阅、脚本不存在，只能手动：

```bash
rm -rf /ql/data/kugouApi
```

然后在青龙面板删除 `KUGOU_ACCOUNTS`。

## 常见问题

### 未找到酷狗账号

先运行「酷狗扫码登录（含 API 安装）」并扫码。签到任务在无账号时不会安装 API，也不会发送失败通知。

### QLAPI 不可用

脚本必须在青龙任务中运行。直接执行 `node kugou_sign.js` 没有 `QLAPI`，会提示：

```text
请在青龙任务中运行本脚本，QLAPI 不可用。
```

### token 写回环境变量失败

本次签到仍会使用内存中的新 token 完成，但下次运行可能仍使用旧 token。请检查：

- 青龙版本是否支持 `QLAPI.getEnvs` / `createEnv` / `updateEnv`
- `KUGOU_ACCOUNTS` 是否被手动改成了非法 JSON
- 青龙 gRPC 服务是否正常

### API 安装失败

脚本固定安装 `v1.6.3`，使用 `https://registry.npmmirror.com`。检查容器网络、代理和磁盘空间后，重新运行登录任务即可。安装失败不会破坏已有可用版本。

### 触发风控（ssa-code）

停止该账号的后续请求，稍后手动在酷狗 App 中完成验证。不要高频重试，也不要用真实账号反复测试接口。

### 概念版（lite）

在青龙环境变量中添加：

```text
KUGOU_PLATFORM=lite
```

然后重新扫码登录。标准平台与概念版账号的 token 不通用。

## 数据与隐私

- token 只存储在青龙环境变量 `KUGOU_ACCOUNTS`
- 不写 `accounts.json`，不使用青龙应用 / OpenAPI
- 日志中的 token 只显示前 4 位与后 4 位
- 不打印完整 `KUGOU_ACCOUNTS` 或完整 cookie
- `state.json` 只保存 API 版本和设备身份，不保存 token
- 环境变量在青龙面板可见，也会注入所有任务，请勿截图外发

## 目录结构

```text
kugou-sign/
├── kugou_sign.js       # 签到入口 + 核心逻辑
├── kugou_login.js      # 登录入口（薄包装）
├── kugou_uninstall.js  # 卸载清理入口（薄包装）
├── README.md
└── LICENSE
```

运行时目录：

```text
/ql/data/kugouApi/
├── state.json
├── qr.png
├── env.lock/
├── install.lock/
└── runtime/
    └── KuGouMusicApi/
```

## 更新日志

### v1.0.0

- 首个版本：扫码登录、多账号、每日签到、QLAPI 写回、卸载清理
- 固定 KuGouMusicApi `v1.6.3`

## License

[MIT](./LICENSE)
