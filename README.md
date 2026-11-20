# AVL Computer Use

DSH Web 的外部桌面插件。DSH 负责对话、会话和工具调度。独立的 Linux/X11 桌面服务采集视频帧并管理鼠标键盘。视觉模型通过独立 WebSocket 持续接收帧，返回观察和候选动作。浏览器可在 DSH 的右侧「远程桌面」标签页观看、放大和接管。

阅读源码时可先看[系统架构图与源码导航](docs/architecture.md)。

当前的 Qwen3-VL 模拟器接收视频流，在模型端按 `AVL_SIM_INFERENCE_FPS` 抽样。默认采集 24 fps、抽样 2 fps，约 22 帧/秒在模拟器中丢弃。空闲时用抽样帧做只读观察。执行桌面工具时，任务推理优先，并使用下一张符合抽样节奏的帧。HTTP 推理期间持续接收后续帧。面板分别显示实际接收帧率、完成的推理帧率和抽样丢帧数。

## 启动桌面服务

在有桌面 `DISPLAY`、X11 访问权限、FFmpeg（`x11grab`）和 `xdotool` 的 Linux 桌面容器执行。采集尺寸应与远端桌面实际尺寸一致。下面的两个令牌使用独立的随机值。

```bash
python3 -m pip install -e .
export DISPLAY=:1
export AVL_WIDTH=1920 AVL_HEIGHT=1080 AVL_CAPTURE_FPS=24
export AVL_DESKTOP_TOKEN='<桌面服务令牌>'
export AVL_MODEL_TOKEN='<模型连接令牌>'
export AVL_BIND_ADDRESS=0.0.0.0 AVL_PORT=8080
bash tools/backend.sh desktop --ssl-certfile /path/to/cert.pem --ssl-keyfile /path/to/key.pem
```

TLS 也可以由同一服务前的反向代理提供。开发中使用 `AVL_SYNTHETIC=1` 会产生 24 fps 的 FFmpeg 测试画面，输入返回 `simulated`。桌面服务使用单个进程，以便控制权和动作状态一致。

## 启动 Qwen3-VL 模拟器

模拟器可以和 Qwen 推理服务部署在一起，也可以部署在能访问两个服务的网络中。使用 OpenAI 兼容的 Qwen3-VL 服务，`AVL_QWEN_BASE_URL` 填到 `/v1`。

```bash
python3 -m pip install -e .
export AVL_MODEL_WS='wss://desktop.example:8080/v1/model'
export AVL_MODEL_TOKEN='<模型连接令牌>'
export AVL_QWEN_BASE_URL='http://127.0.0.1:8000/v1'
export AVL_QWEN_MODEL='Qwen/Qwen3-VL-8B-Instruct'
export AVL_QWEN_API_KEY='<模型服务要求时填写>'
export AVL_SIM_INFERENCE_FPS=2
bash tools/backend.sh simulator
```

可将采集帧率设为 12–24，抽样频率设为 `(0, 24]`。推理慢于抽样频率时，结果率自然低于设置值。可以用 `bash tools/backend.sh simulator --no-idle-inference` 只在有桌面工具请求时运行推理。动作依据的帧超过 `AVL_FRESH_SECONDS`（默认 5 秒）将被拒绝，可根据 Qwen 实测延迟调节。真实流式模型也受相同的新鲜度检查。

## 启动 DSH Web 和固定 SSH 工作区

DSH Host 需要 Node.js 24.9+、OpenSSH、Linux 上的 `sshfs` / FUSE，以及专用的 `DSH_HOME`。在 Host 的 SSH 配置预先定义主机别名 `avl-desktop`、用户、私钥和已验证的 host key。SSH 服务需允许 Unix 套接字转发。

在远端桌面容器，用 Node.js 24.9+ 安装与 DSH 同版本的 helper。安装目录应位于工作区和可写临时目录之外，由部署方维护。

```bash
npm install --prefix /opt/avl-ssh-helper --omit=dev @deepseek-ai/dsh-ssh@0.2.2-rc.5
command -v node
sha256sum /opt/avl-ssh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
```

回到 DSH Host 执行下面的命令。使用已有的独立 helper 可执行文件时，设置其路径和 SHA-256，省略 `AVL_SSH_NODE`。

```bash
npm ci
npm run build

export AVL_SSH_HOST=avl-desktop
export AVL_WORKSPACE=/srv/avl-workspace
export AVL_SSH_NODE=/usr/bin/node                     # 远端 Node 的绝对路径
export AVL_SSH_HELPER=/opt/avl-ssh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
export AVL_SSH_HELPER_SHA256='<远端 helper 文件的 SHA-256>'
export DSH_HOME="$HOME/.local/state/avl-dsh"
export AVL_DESKTOP_URL='https://desktop.example:8080'
export AVL_DESKTOP_TOKEN='<桌面服务令牌>'

# Host 上预建同路径挂载点。远端工作区也必须已存在，且为规范路径。
sshfs "${AVL_SSH_HOST}:${AVL_WORKSPACE}" "$AVL_WORKSPACE" \
  -o "ro,BatchMode=yes,StrictHostKeyChecking=yes,attr_timeout=0,entry_timeout=0,fsname=${AVL_SSH_HOST}:${AVL_WORKSPACE}"

bash tools/app.sh --no-open
```

打开终端打印的 DSH 登录链接，在会话右侧面板选择「远程桌面」。在聊天中配置 DSH 主模型后，让 Agent 调用 `remote_desktop_step`。工具每次执行至多一个动作，也支持 `observe_only=true`。

SSHFS 只读视图供 DSH Web 的本机目录检查使用。工具的文件与子进程由 DSH 原生 SSH helper 访问。启动器验证挂载确实来自固定别名和路径，Host 只允许在这一工作区建会话。SSH 丢失后，现有 DSH SSH provider 会拒绝新的工作区操作。恢复连接和挂载后重启 DSH，历史会话由专用 `DSH_HOME` 保留。可执行 helper、Unix 套接字转发和平台依赖见 [DSH SSH 部署说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ssh/ssh/README.md)。

桌面标签页使用带帧序号的 WebSocket 视频流。已有的 noVNC 可以继续用于只读查看或独立运维。需要受 Agent／人工控制权约束的输入统一通过本插件。

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
npm run build
```

Python 联调使用 FFmpeg 测试画面和模拟 Qwen HTTP 响应，覆盖持续收帧、抽样、慢推理、人工接管、模型断连以及拉起新连接。人工控制连接断开后暂停输入，重新连接可观看画面，再明确「接管桌面」或「交还 Agent」。动作回执未知时，Agent 需要先执行只观察操作。
