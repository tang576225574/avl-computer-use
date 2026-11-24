# AVL Computer Use

在 DSH 聊天中让 Agent 操作容器里的 XFCE 桌面。操作者可以打开右侧「桌面控制台」观看、接管键鼠，再把控制权交还给 Agent。桌面和 DSH Host 共用一个容器、本地文件系统和 X11 显示。插件使用 DSH 的 Web 服务、会话和工具接口，使用 DSH 原生本地工作区，可同时保留多个项目和对话。所有工作区的主 Agent 与子 Agent 共用一条桌面队列，按申请顺序获得控制权。

- 阅读源码从[架构图、文本时序和故障行为](docs/architecture.md)开始。
- 部署桌面镜像、配置外网地址和了解进程恢复见[容器运行手册](docs/container.md)。
- 部署 Qwen3-VL、接入未来的逐帧模型和复现延迟测量见[模型协议与基准](docs/model.md)。

## 启动桌面容器

在有 Docker 的宿主机上，由部署系统注入两个值不同的环境变量。也可以在当前 Bash 中交互输入。请将同一个模型令牌配置到模型机器。密码只用于容器内预定义的本地运维操作。

```bash
read -rsp '运维 sudo 密码：' AVL_SUDO_PASSWORD; echo
read -rsp '模型连接令牌（不含空白）：' AVL_MODEL_TOKEN; echo
export AVL_SUDO_PASSWORD AVL_MODEL_TOKEN
docker build -t avl-desktop:v2 .
docker run --name avl -p 127.0.0.1:3080:3080 \
  -e AVL_SUDO_PASSWORD -e AVL_MODEL_TOKEN \
  -e DSH_PUBLIC_URL=http://127.0.0.1:3080 \
  -v avl-ssh-hostkeys:/var/lib/avl-sshd \
  avl-desktop:v2
```

打开启动日志中带登录凭证的 DSH 链接，在 DSH 中选择本地工作目录和支持工具调用的主模型。需要保留对话和文件时，持久化桌面用户的 `DSH_HOME` 和工作目录。容器每次启动时由插件启动并监控桌面。DSH 退出后，tini 返回子进程退出状态，容器随之停止。

上面的端口映射仅供本机使用。模型跨机器时，为同一 DSH 服务提供 HTTPS/WSS 入口，把 `DSH_PUBLIC_URL` 设成浏览器实际访问的根地址，再将模型指向该入口。启动参数、持久卷和验收脚本见[容器运行手册](docs/container.md)。

## 启动模型，完成一次桌面任务

在模型机器上准备可接收图像的 Qwen3-VL 推理端点。以下命令在本仓库根目录运行，建议使用 Python 3.11+ 虚拟环境。

```bash
python3 -m pip install .
read -rsp '模型连接令牌：' AVL_MODEL_TOKEN; echo
export AVL_MODEL_TOKEN
export AVL_MODEL_WS=wss://desktop.example.org/avl/model
export AVL_QWEN_BASE_URL=http://127.0.0.1:8000/v1
export AVL_QWEN_MODEL=Qwen/Qwen3-VL-8B-Instruct
python3 -m model.adapter
```

纯本机部署时使用 `ws://127.0.0.1:3080/avl/model`。连接后，控制台显示模型模式 `simulator`。在 DSH 发送「打开设置，把界面语言改成中文」。主模型调用 `desktop_stream_start` 排队，获准后得到 `leaseId`。每次 `desktop_step` 以及最后的 `desktop_stream_stop` 都要带上这个标识。首次或视频空闲停送后先用 `observe_only: true` 观察。浏览器显示持有者和排队数，需要介入时点击「中断并接管」。Host 通知被中断的 Agent 及其所属主 Agent，确认在途键鼠停止后才允许网页输入。点击「交还 Agent」后，队首获得新的租约。

**主模型和视觉模型分别配置。** DSH 会话的主模型负责读历史和调用工具，`AVL_QWEN_MODEL` 只选择执行视觉步骤的模型。若两端都用 Qwen3-VL，在 DSH 的模型设置中另行配置其兼容接口、凭据和模型 ID，并选为该会话的主模型。作为主模型时，推理服务还需要支持 DSH 工具调用。未来模型要逐帧接收和处理时，接入同一 WSS 接口并声明 `full` 模式，协议、回执格式和例子见[模型接入指南](docs/model.md)。

## 在已有桌面上开发

需要 Node.js 24.9+、npm、FFmpeg 和 xdotool。安装依赖并构建 React 面板后，启动脚本会从独立运行目录启动 DSH，配置从启动进程的环境传入。默认监听回环地址 3080，默认关闭本机桌面运维。首次运行可以选择测试画面，只观察而不触碰当前显示器。

```bash
npm ci
npm run build
read -rsp '模型连接令牌：' AVL_MODEL_TOKEN; echo
export AVL_MODEL_TOKEN
AVL_SYNTHETIC=1 ./tools/dsh.sh
```

要操作现有桌面，确保启动用户的 `DISPLAY` 和 `XAUTHORITY` 可以访问目标显示器，运行 `./tools/dsh.sh`。模型接收进程独立启动。默认的 DSH 状态路径是 `$HOME/.local/state/avl-dsh`，可用绝对路径 `DSH_HOME` 覆盖。容器注入的 sudo 密码只由容器入口消费，本地开发命令使用没有该变量的 shell。

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `AVL_CAPTURE_FPS` | 24 | 目标采集率，整数 12–24。控制台显示实际接收率 |
| `AVL_STREAM_WRITE_TIMEOUT_MS` | 1000 | 单连接写出超时。等待期间仅保留下一张最新画面 |
| `AVL_STREAM_IDLE_MS` | 60000 | 两步之间模型视频的最长空闲时间。停送后仍保留本轮控制权 |
| `AVL_FRAME_FRESH_MS` | 5000 | 允许输入所依据的帧从 Host 编码完成至今的最大毫秒数 |
| `AVL_STEP_TIMEOUT_MS` | 30000 | 单个视觉决策的最长等待时间 |
| `AVL_SIM_INFERENCE_FPS` | 2 | 模型端模拟器每秒发起后台视觉采样的上限 |

## 运行验证

```bash
npm ci
npm run build
python3 -m pip install .
npm test
python3 -m unittest discover -s tests -v
node tests/benchmark.mjs
```

工作区测试会启动并重启临时 DSH。X11 测试使用单独显示号和认证 cookie。基准输出分别报告采集、模型接收、实际处理及延迟，还会检查订阅前后模型收到的视频帧数。真实模型的控件定位通过 `python3 -m model.evaluate --qwen` 评估。在具备 Docker 的机器上运行 `python3 container/test-lifecycle.py avl-desktop:v2` 验证容器冷启动、故障修复和 DSH 退出行为。
