# 酷狗签到（青龙）

在青龙面板中完成酷狗概念版的**扫码登录**与**每日签到**。脚本会在本机自动安装固定版本的 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)，以进程内方式调用，不需要额外部署 API 容器。

## 功能

- 青龙订阅拉库后自动创建 3 个任务：
  - 酷狗扫码登录
  - 酷狗签到
  - 酷狗卸载清理
- token 只存青龙环境变量 `KUGOU_ACCOUNTS`，刷新后通过青龙内置 `QLAPI` 写回
- 多账号：每扫一次码添加一个账号，按 `userid` 去重

> **免责声明**：本项目使用非官方接口，仅供个人学习研究使用。请遵守酷狗用户协议，不要公开分享 token，不要用于商业用途。因使用本项目产生的任何后果由使用者自行承担。

## 青龙拉库

进入青龙面板，点击左侧菜单「订阅管理」，点击右上角「新建订阅」：

| 字段 | 填写内容 |
|---|---|
| 类型 | 公开仓库 |
| 链接 | `https://github.com/smr8890/kugou_checkin_qinglong.git` |
| 分支 | `main` |
| 定时规则 | 按需选择 |
| 自动添加任务 | 开启 |

填写完成后点击「确定」，然后点击「运行」按钮手动拉取一次，等待状态变为「完成」。拉取成功后会自动创建 3 个任务：

- 酷狗扫码登录
- 酷狗签到
- 酷狗卸载清理

也可以使用命令行：

```bash
ql repo https://github.com/smr8890/kugou_checkin_qinglong.git "" "" "" "main"
```

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `KUGOU_ACCOUNTS` | 登录后自动创建 | 账号 JSON 数组，token 唯一存储位置 |
| `KUGOU_PLATFORM` | 否 | 留空为标准平台；填 `lite` 为概念版 |

登录和签到必须使用同一个 `KUGOU_PLATFORM` 值。不同平台的 token 不通用。

临时禁用账号：把 `KUGOU_ACCOUNTS`中对应账号的`"enabled": true` 改为 `false`。彻底删除账号：从数组中移除该项。

## 首次扫码登录

1. 打开青龙「任务管理」
2. 运行「酷狗扫码登录」
3. 首次运行会自动下载并安装 KuGouMusicApi（需要几分钟）
4. 日志中会出现终端二维码、二维码链接，并保存到 `/ql/data/kugouApi/qr.png`
5. 使用酷狗 App 扫码并确认
6. 登录成功后，账号自动写入 `KUGOU_ACCOUNTS`
7. 登录完成后建议**禁用登录任务**，避免误触发

## 添加多个账号

再次运行「酷狗扫码登录」并扫码即可。脚本按 `userid` 去重：

- 同一账号重复扫码：更新 token
- 不同账号：追加到数组

## 每日签到

「酷狗签到」任务默认每天 `07:17` 执行，token 超过 7 天会在签到前自动刷新，刷新结果写回 `KUGOU_ACCOUNTS`。

## 通知

使用青龙内置通知模块`sendNotify.js`，请在青龙配置文件中配置通知渠道。

## 卸载清理

青龙删除订阅时**不会**删除：

```text
/ql/data/kugouApi
```

因此删除订阅前请先运行「酷狗卸载清理」。

如果已经删除订阅、脚本不存在，只能手动删除`/ql/data/kugouApi`目

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

## 常见问题

### API 安装失败

脚本固定安装 `v1.6.3`，使用 `https://registry.npmmirror.com`。检查容器网络、代理和磁盘空间后，重新运行登录任务即可。安装失败不会破坏已有可用版本。

## License

[MIT](./LICENSE)
