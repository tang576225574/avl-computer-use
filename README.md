# AVL Computer Use

DSH Web 的外部桌面插件。DSH 负责对话、会话和工具调度。独立的 Linux/X11 桌面服务采集视频帧并管理鼠标键盘。视觉模型通过独立 WebSocket 持续接收帧，返回观察和候选动作。浏览器可在 DSH 的右侧「远程桌面」标签页观看、放大和接管。

阅读源码时可先看[系统架构图与源码导航](docs/architecture.md)。

当前的 Qwen3-VL 模拟器接收视频流，在模型端按 `AVL_SIM_INFERENCE_FPS` 抽样。默认采集 24 fps、抽样 2 fps，约 22 帧/秒在模拟器中丢弃。空闲时用抽样帧做只读观察。执行桌面工具时，任务推理优先，并使用下一张符合抽样节奏的帧。HTTP 推理期间持续接收后续帧。面板分别显示实际接收帧率、完成的推理帧率和抽样丢帧数。

## 在现有桌面环境启动后端

使用已有的 X11、XFCE、VNC 和 SSH 服务。后端需要能访问 X11 的 FFmpeg 和 `xdotool`。配置采集尺寸和 `DISPLAY` 时，以桌面实际设置为准。当前环境的 `8080` 已被 fgai-omni 使用，以下示例用 `8081`。

```bash
python3 -m pip install -e .
export DISPLAY=:1 AVL_WIDTH=1920 AVL_HEIGHT=1080 AVL_CAPTURE_FPS=24
export AVL_DESKTOP_TOKEN='<桌面服务令牌>'
export AVL_MODEL_TOKEN='<另一个模型连接令牌>'
export AVL_STREAM_WRITE_TIMEOUT_MS=1000
export AVL_BIND_ADDRESS=127.0.0.1 AVL_PORT=8081
export AVL_DESKTOP_STATE="$HOME/.local/state/avl-desktop/control.sqlite"
install -d -m 0700 "$(dirname "$AVL_DESKTOP_STATE")"
bash tools/backend.sh desktop
```

跨机器访问时，通过支持 WebSocket Upgrade 的 HTTPS 代理转发到桌面侧的后端地址。DSH 和视觉模型使用代理的 HTTPS/WSS 地址，各自带上对应令牌。开发时可加 `AVL_SYNTHETIC=1` 使用测试画面。

`AVL_STREAM_WRITE_TIMEOUT_MS` 控制单次 WebSocket 写入的等待上限，单位为毫秒，默认 `1000`。例如要等 2.5 秒，把桌面后端的进程环境和 DSH Host 项目 `.env` 都设为 `2500`，分别重启两个服务。桌面端的值覆盖发往模型和前端代理的两路发送，Host 的值覆盖代理发往浏览器的一跳。等待期间，每一路都用新帧替换待发旧帧。达到上限时仅断开该连接。

## 启动 Qwen3-VL 模拟器

模拟器可以和 Qwen 推理服务部署在一起，也可以部署在能访问两个服务的网络中。使用 OpenAI 兼容的 Qwen3-VL 服务，`AVL_QWEN_BASE_URL` 填到 `/v1`。

```bash
python3 -m pip install -e .
export AVL_MODEL_WS='wss://desktop.example/v1/model'
export AVL_MODEL_TOKEN='<模型连接令牌>'
export AVL_QWEN_BASE_URL='http://127.0.0.1:8000/v1'
export AVL_QWEN_MODEL='Qwen/Qwen3-VL-8B-Instruct'
export AVL_QWEN_API_KEY='<模型服务要求时填写>'
export AVL_SIM_INFERENCE_FPS=2
bash tools/backend.sh simulator
```

可将采集帧率设为 12–24，抽样频率设为 `(0, 24]`。推理慢于抽样频率时，结果率自然低于设置值。可以用 `bash tools/backend.sh simulator --no-idle-inference` 只在有桌面工具请求时运行推理。动作依据的帧超过 `AVL_FRESH_SECONDS`（默认 5 秒）将被拒绝，可根据 Qwen 实测延迟调节。真实流式模型也受相同的新鲜度检查。

## 启动 DSH Web 和固定 SSH 工作区

DSH Host 需要 Node.js 24.9+、OpenSSH、Linux 上的 SSHFS / FUSE，以及专用的 `DSH_HOME`。先把 DSH Host 项目目录中的 `.local/ssh/avl-desktop_ed25519.pub` **追加**到桌面容器所选用户的 `~/.ssh/authorized_keys`，并确保远端 `~/.ssh` 权限是 `0700`、`authorized_keys` 是 `0600`。私钥留在 DSH Host。将通过可信渠道核对过的桌面 SSH 主机公钥加入 DSH Host 的 `~/.ssh/known_hosts`。

远程工作区应已存在，桌面 SSH 服务需允许 Unix 套接字转发。在远端安装同版本的 DSH helper，记录远端 Node、helper 路径和 helper 的 SHA-256。

```bash
npm install --prefix /opt/avl-ssh-helper --omit=dev @deepseek-ai/dsh-ssh@0.2.2-rc.5
command -v node
sha256sum /opt/avl-ssh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
```

DSH Host 的项目 `.env` 使用以下配置。绝对路径填写实际值。若使用独立 helper 可执行文件，可省略 `AVL_SSH_NODE`。

```dotenv
AVL_SSH_ADDRESS=desktop.example
AVL_SSH_PORT=22
AVL_SSH_USER=tang
AVL_SUDO_PASSWORD=
AVL_WORKSPACE=/srv/avl-workspace
AVL_SSH_NODE=/usr/bin/node
AVL_SSH_HELPER=/opt/avl-ssh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
AVL_SSH_HELPER_SHA256=<远端 helper 文件的 SHA-256>
DSH_HOME=/home/your-user/.local/state/avl-dsh
AVL_STREAM_WRITE_TIMEOUT_MS=1000
AVL_DESKTOP_URL=https://desktop.example
AVL_DESKTOP_TOKEN=<桌面服务令牌>
```

启动器会读项目 `.env` 和已导出的环境变量。保存 sudo 密码时，请先执行 `chmod 600 .env`。默认使用 `.local/ssh/avl-desktop_ed25519`，可用 `AVL_SSH_KEY` 指定别的私钥。默认工作区别名是 `avl-desktop`，可用 `AVL_SSH_HOST` 覆盖。只设置现有 SSH 别名时，也可沿用用户自己的 OpenSSH 配置。

DSH 命令行也会读取启动目录的 `.env`。本项目的启动器让 DSH 从私有临时目录启动，并从子进程环境中移除 `AVL_SUDO_PASSWORD`。运维插件通过一次性私有文件取得密码，读取后立即删除该文件。`DSH_HOME/.env` 继续用于 DSH 自身的配置。

在 DSH Host 生成 SSH 配置，测试公钥登录并挂载工作区。以下以默认别名为例，挂载路径须与 `AVL_WORKSPACE` 一致。

```bash
npm ci
npm run build
install -d -m 0700 .local/ssh
(umask 077 && bash tools/app.sh --ssh-config > .local/ssh/config)
ssh -F .local/ssh/config avl-desktop true

workspace=/srv/avl-workspace
sshfs -F .local/ssh/config "avl-desktop:${workspace}" "$workspace" \
  -o "ro,reconnect,ServerAliveInterval=10,ServerAliveCountMax=3,attr_timeout=0,entry_timeout=0,fsname=avl-desktop:${workspace}"
bash tools/app.sh --no-open
```

打开终端打印的 DSH 登录链接，在右侧面板选择「远程桌面」。SSHFS 的只读视图供 DSH Web 校验路径。文件访问和子进程通过 DSH 原生 SSH helper 执行。变更远端地址、用户、端口或密钥后，重新挂载 SSHFS 再启动 DSH。DSH 工作区传输失效时，恢复连接和挂载后手动重启 DSH，历史保存在专用的 `DSH_HOME`。更多远端要求见 [DSH SSH 部署说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ssh/ssh/README.md)。

### 运维 SSH 和 sudo

`AVL_SUDO_PASSWORD` 是远端用户执行 sudo 的密码。SSH 本身使用公钥。填写该变量后，DSH 默认用 `avl-desktop-ops` 在工作区 helper 可达时建立独立运维连接，密码通过该连接的标准输入交给远端 `sudo -S`。默认运维连接复用工作区账号，适用于受你信任的账号和登录环境。需要独立运维身份时，将 `AVL_OPS_SSH_HOST` 设置为 `~/.ssh/config` 中已有的运维别名。密码留空且未配置运维别名时，DSH 只连接工作区和桌面服务。

自动恢复需要在远端准备受管理员保护的 [固定运维入口](desktop/privileged-ops.sh) 及对应的服务管理配置。入口默认位置是 `/opt/avl/desktop/privileged-ops.sh`，其 Python 环境是 `/opt/avl-venv`。配置 sudo 时仅授予 `probe` 和规定的 `recover` 命令，详见 [sudoers 示例](desktop/sudoers)。桌面本身使用原有的 SSH 登录和启动方式，安装公钥后即可先验证 SSH。已有受限运维账号也可沿用原来的 `probe` / `recover` 接口。

启用运维时，用管理员拥有的 `/etc/avl/desktop-ops.json` 指定现有服务的端口、X11 授权文件和 Supervisor 配置。Supervisor 需已纳管 `x11`、`xfce`、`novnc` 和 `backend`。后端探测通过 `/v1/health` 检查新帧。

```json
{
  "display": ":1",
  "xauthority": "/home/tang/.Xauthority",
  "vnc_port": 5902,
  "novnc_port": 6902,
  "backend_port": 8081,
  "supervisor_config": "/etc/supervisor/supervisord.conf"
}
```

## 接入你的全帧模型

启动你的模型服务，停止 Qwen3-VL 模拟器，让新服务作为 **WebSocket 客户端**连接同一个 `wss://<desktop>/v1/model`，握手请求带 `Authorization: Bearer <AVL_MODEL_TOKEN>`。DSH 工具和前端复用原配置。桌面服务一次接纳一个模型连接。

完整消息示例见 [模型流协议](docs/model-stream.md)。关键步骤如下。

1. 连接后立即发送 `{"type":"hello","v":1,"mode":"full"}`。
2. 在独立接收循环中读所有二进制帧，解出帧序号和 JPEG，送入视觉编码器。周期性上报真实的 `received`、`processed`、`seq` 与 `processed_seq`。模型每次重连从新计数开始。
3. 收到 `start` 后，从同一流中使用 `after_seq` 之后已经编码的帧作决策。先上报处理进度，再带该帧序号返回 `result`。收到 `cancel` 停止对应任务。桌面服务负责动作执行。
4. 用模型端实际编码帧率和动作延迟验证真实模型。全帧模式在接收或处理速率达不到 12 fps 时暂停 Agent 输入。

## 联调与断线

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.test.mjs
npm run build
```

Python 联调使用 FFmpeg 测试画面和模拟 Qwen HTTP 响应，覆盖持续收帧、抽样、慢推理、人工接管、模型断连以及拉起新连接。人工控制连接断开后暂停输入，重新连接可观看画面，再明确「接管桌面」或「交还 Agent」。动作回执未知时，Agent 需要先执行只观察操作。

设置 `AVL_DESKTOP_STATE` 后，后端重启会保留近期请求的去重记录和人工接管的暂停状态。如果重启前提交过可执行动作的请求，且随后没有完成一次只观察操作，恢复后的第一次 Agent 操作需要先观察新画面。

DSH 每 5 秒检查工作区 helper。启用运维时，只有 helper 响应才会探测桌面服务，每次发出修复命令前会再次确认。检测到 helper 失联后，插件关闭运维 SSH，暂停桌面探测与修复，在聊天页和 Host 日志告警。已送达远端的修复可能继续执行。helper 再次就绪后，插件从新探测开始。当前原生 helper 传输失效后需要恢复 SSH、确认挂载并手动重启 DSH Web。SSH 服务自身退出时，需要桌面宿主机的独立恢复通道。
