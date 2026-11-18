# dsh-ollama-autostart

DSH Host 插件：宿主（dsh）每次启动时自动拉起 `ollama serve` 后台服务；已在运行则自动跳过。

| 项目 | 说明 |
| --- | --- |
| 类型 | Host-only bundle（无 UI 渲染） |
| 依赖 | 宿主用户态已安装 `ollama` 二进制 |
| 许可证 | MIT |

## 支持环境：仅 DSHA

> **本插件仅面向 DSHA**（Android 上以 proot/Ubuntu 运行 dsh 的环境）：宿主的 `/usr/local/bin/ollama` 由 DSHA 用户态提供，插件在宿主进程启动阶段自动完成服务拉起。
> **桌面版 dsh（Desktop/CLI）不需要它**：桌面环境的 ollama 通常由系统服务（systemd 等）托管，不存在"宿主启动时顺手拉起"的需求。
>
> **DSHA only.** This plugin targets DSHA (dsh running on Android, proot/Ubuntu). Desktop dsh does not need it — ollama there is normally managed by a system service.

## 前置条件

> 本插件为 **dsh-mnemon 扩展插件**：面板中的「强制 IPv4 CLI 测试」调用 `mnemon` CLI（由 dsh-mnemon 提供）。请先安装并启用 `dsh-mnemon`，再使用本插件。
>
> This plugin is an extension of **dsh-mnemon**: the forced-IPv4 CLI test invokes the `mnemon` CLI shipped by dsh-mnemon. Install and enable `dsh-mnemon` first.

## 行为

宿主激活本插件时（`apply`）：

1. 探测 `127.0.0.1:11434`（可配置）是否已有服务监听 → 有则记录日志并跳过；
2. 检查 pidfile（`/tmp/dsh-ollama-autostart.pid`）中的进程是否存活（上一次拉起尚在启动中）→ 存活则跳过；
3. 否则 `spawn("ollama", ["serve"], { detached: true, stdio: "ignore" })` 并 `unref()`——服务脱离宿主进程组，**dsh 退出后继续存活**；
4. 后台每 1 秒轮询端口，30 秒内就绪则记录 `ollama ready`，超时记录告警（不阻断宿主启动）。

全程幂等：多实例、HMR 重激活、配置变更重复触发都不会产生重复进程。

## 行配置（可选）

```json
{ "command": "ollama", "args": ["serve"], "host": "127.0.0.1", "port": 11434 }
```

## 安装（DSHA profile）

profile `package.json` 的 `dependencies`：

```json
"dsh-ollama-autostart": "github:<你的用户名>/dsh-ollama-autostart"
```

然后在 profile 目录执行 `pnpm install`（或经插件管理器安装）。安装后宿主启动即自动生效。

## 日志

宿主日志中前缀 `ollama-autostart:`，例如：

```
ollama-autostart: ollama already listening on 127.0.0.1:11434 — skipped
ollama-autostart: spawned "ollama serve" as detached pid 27472; waiting for 127.0.0.1:11434…
ollama-autostart: ollama ready on 127.0.0.1:11434
```
