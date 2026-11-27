# AVL Computer Use

在 DSH 聊天中让 Agent 操作容器里的 XFCE 桌面。操作者可以打开右侧「桌面控制台」观看、接管键鼠，再把控制权交还给 Agent。桌面和 DSH Host 共用一个容器、本地文件系统和 X11 显示。插件使用 DSH 的 Web 服务、会话和工具接口，使用 DSH 原生本地工作区，可同时保留多个项目和对话。所有工作区的主 Agent 与子 Agent 共用一条桌面队列，按申请顺序获得控制权。

- 阅读源码从[架构图、文本时序和故障行为](docs/architecture.md)开始。
- 部署桌面镜像、配置外网地址和了解进程恢复见[容器运行手册](docs/container.md)。
- 部署 Omni 视觉适配器、接入未来的逐帧模型和复现延迟测量见[模型协议与基准](docs/model.md)。

## 启动桌面容器

在有 Docker 的宿主机上，由部署系统注入两个值不同的环境变量。第一次部署时自行生成并保存两份独立凭据（可分别运行一次 `openssl rand -hex 32`），再在当前 Bash 中交互输入。请将同一个模型令牌配置到模型机器。密码只用于容器内预定义的本地运维操作。

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

也可以直接使用已经上传到dockerhub的镜像进行启动

```bash
# 不带cuda的镜像
docker run --name avl -p 127.0.0.1:3080:3080 \
  -e AVL_SUDO_PASSWORD -e AVL_MODEL_TOKEN \
  -e DSH_PUBLIC_URL=http://127.0.0.1:3080 \
  -v avl-ssh-hostkeys:/var/lib/avl-sshd \
  tang576225574/deployer:ubuntu24.04-v20261126-dsh
# 包含cuda的镜像
docker run --name avl -p 127.0.0.1:3080:3080 \
  -e AVL_SUDO_PASSWORD -e AVL_MODEL_TOKEN \
  -e DSH_PUBLIC_URL=http://127.0.0.1:3080 \
  -v avl-ssh-hostkeys:/var/lib/avl-sshd \
  tang576225574/deployer:ubuntu24.04-v20261126-cuda130-dsh
```

**SSH 主机密钥挂载是可选的。** 只通过 DSH 网页使用桌面时，可以省略示例中的 `-v avl-ssh-hostkeys:/var/lib/avl-sshd`。如果还通过 SSH 登录，保留挂载可以让客户端在容器重建后继续识别同一台服务器。

- 左侧 `avl-ssh-hostkeys` 是 Docker 命名卷，名称可自定。重建同一服务时复用原卷即可。
- 右侧 `/var/lib/avl-sshd` 是当前容器入口固定使用的目录。入口在这里读取 `host_ed25519`，文件缺失时自动生成。用户登录用的公钥另存于桌面用户的 `~/.ssh/authorized_keys`。
- 省略挂载后，`docker restart avl` 重启同一个容器仍会保留密钥。删除容器再新建时，如果未保留该目录，服务器会生成新密钥，曾连接同一地址和端口的 SSH 客户端会提示指纹已变化。

打开启动日志中带登录凭证的 DSH 链接，在 DSH 中选择本地工作目录和支持工具调用的主模型。需要保留对话和文件时，持久化桌面用户的 `DSH_HOME` 和工作目录。容器每次启动时由插件启动并监控桌面。DSH 退出后，tini 返回子进程退出状态，容器随之停止。

上面的端口映射仅供本机使用。模型跨机器时，为同一 DSH 服务提供 HTTPS/WSS 入口，把 `DSH_PUBLIC_URL` 设成浏览器实际访问的根地址，再将模型指向该入口。启动参数、持久卷和验收脚本见[容器运行手册](docs/container.md)。

## 启动模型，完成一次桌面任务

在模型机器上准备支持图像输入的 OpenAI 兼容推理端点。以下命令在本仓库根目录运行，建议使用 Python 3.11+ 虚拟环境。

```bash
python3 -m pip install .
read -rsp '模型连接令牌：' AVL_MODEL_TOKEN; echo
export AVL_MODEL_TOKEN
export AVL_MODEL_WS=wss://desktop.example.org/avl/model
export AVL_OMNI_BASE_URL=http://127.0.0.1:8000/v1
export AVL_OMNI_MODEL=Qwen/Qwen3-VL-8B-Instruct
python3 -m model.adapter
```

纯本机部署时使用 `ws://127.0.0.1:3080/avl/model`。连接后，控制台显示模型模式 `simulator`。在 DSH 发送「打开设置，把界面语言改成中文」。主模型调用 `desktop_stream_start` 排队，获准后得到 `leaseId`。每次 `desktop_step` 以及最后的 `desktop_stream_stop` 都要带上这个标识。首次或视频空闲停送后先用 `observe_only: true` 观察。浏览器显示持有者和排队数，需要介入时点击「中断并接管」。Host 通知被中断的 Agent 及其所属主 Agent，确认在途键鼠停止后才允许网页输入。点击「交还 Agent」后，队首获得新的租约。

**主模型和视觉模型分别配置。** DSH 会话的主模型负责读历史和调用工具，`AVL_OMNI_MODEL` 只选择执行视觉步骤的模型。若两端共用同一模型，在 DSH 的模型设置中另行配置其兼容接口、凭据和模型 ID，并选为该会话的主模型。作为主模型时，推理服务还需要支持 DSH 工具调用。未来模型要逐帧接收和处理时，接入同一 WSS 接口并声明 `full` 模式，协议、回执格式和例子见[模型接入指南](docs/model.md)。

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

## 环境变量

[.env.example](.env.example) 列出本项目启动器、插件、视觉适配器和基准程序读取的配置。容器部署最少只需填写 `AVL_SUDO_PASSWORD` 和 `AVL_MODEL_TOKEN`；已有桌面上直接运行 Host 只需后者。前端随 Host 提供，浏览器无需配置环境变量。

### 如何传入

- **桌面容器**：在宿主机执行 `(umask 077 && mkdir -p .local && cp -n .env.example .local/desktop.env)`，填写该文件中的两项必填凭据，按需启用容器配置。保持模型端和基准配置为注释。在上面的 `docker run` 命令中以 `--env-file .local/desktop.env` 替换两个凭据的 `-e` 参数。Docker 环境文件按 `名称=值` 填写，直接写值，不加 shell 引号，也不写命令替换。
- **本地 Host / 模型机器**：分别在启动对应进程的 shell 中用 `export` 或上面的 `read -rsp` 设置。两端均需部署者保存的同一份模型令牌。推理服务的 API Key 只交给模型端；本地直接运行 `./tools/dsh.sh` 时须取消 `AVL_SUDO_PASSWORD`（即使空值也请 `unset AVL_SUDO_PASSWORD`）。这两个启动入口都无需读取仓库根目录的 `.env`。实际凭据文件请保存在版本控制之外。
- **DSH 网页登录**：由 DSH 生成 owner 登录链接。部署者可从 `docker logs avl` 或本地启动终端取得。该链接只交给网页操作者。DSH 会话主模型的服务凭据在 DSH 模型设置中配置。

### 凭据与来源

| 变量 | 配置位置 / 默认值 | 谁设置、从哪里取得、用于什么 |
| --- | --- | --- |
| `AVL_SUDO_PASSWORD` | 桌面容器必填，无默认值 | **部署者自定义**，启动时入口将它设为本地运维账号 `avl-ops` 的新密码，用于固定的 sshd 恢复操作。无需从旧容器获取。单行、非空、最多 512 字节；与模型令牌不同。 |
| `AVL_MODEL_TOKEN` | Host 和视觉适配器均必填，无默认值 | **部署者生成一次，两端填相同值**。视觉端用它向 Host 的 `/avl/model` 认证。用无空白和控制字符的随机串，容器上限 512 字节。第二台机器从部署者的凭据存储取得；丢失时生成新值并在两端同步更换。 |
| `AVL_NOVNC_PASSWORD` | 桌面容器可选，空或未设时每次启动随机生成 8 位 | **部署者可自定义**，6–8 个可打印 ASCII 字符，须区别于上面两项。仅供独立的只读 VNC/noVNC 观看。日常 DSH 面板无需此密码；需要单独登录 VNC 时，启动前指定并保存已知值。入口只写 VNC 密码文件，不输出随机值。 |
| `AVL_OMNI_API_KEY` | 视觉适配器、`model.evaluate --omni`；默认不发送鉴权头 | **取自推理服务**。托管端使用服务商签发的 Key；自部署端使用推理服务管理员配置并认可的 Key。无鉴权端点可留空。容器不签发此 Key。 |

### DSH Host 与桌面视频

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DSH_BIND` | 本地 `127.0.0.1`；容器取自身主机名解析出的 IP | DSH 实际监听地址。Docker 端口映射需要能访问该容器接口。 |
| `DSH_PORT` | `3080` | DSH 网页和模型 WebSocket 共用的监听端口。修改后同步调整端口映射和客户端地址。 |
| `DSH_PUBLIC_URL` | 未设置 | 浏览器访问的 HTTP(S) 根地址，启动器据此设置信任的 Host。只填协议、主机及可选端口；域名、协议和端口应与对外入口一致。 |
| `DSH_HOME` | `$HOME/.local/state/avl-dsh` | DSH 状态、会话和启动目录。覆盖时填当前运行环境内的可写绝对路径；容器部署可挂载持久卷。 |
| `AVL_CAPTURE_FPS` | `24` | 目标采集率，整数 12–24 帧/秒。实际接收率见控制台。 |
| `AVL_STREAM_WRITE_TIMEOUT_MS` | `1000` | 单连接写出超时，整数 1–2147483647 毫秒。等待期间仅保留下一张最新帧，超时关闭该连接。 |
| `AVL_STREAM_IDLE_MS` | `60000` | 两个视觉步骤之间允许的视频空闲时间，整数 100–86400000 毫秒。超时停送模型视频，保留控制权。 |
| `AVL_FRAME_FRESH_MS` | `5000` | 从 Host 编码完成算起，动作依据帧的最大年龄，整数 100–60000 毫秒。超龄动作会被拒绝。 |
| `AVL_STEP_TIMEOUT_MS` | `30000` | 等待一次视觉决策的最长时间，整数 100–180000 毫秒。 |
| `AVL_SYNTHETIC` | 关闭 | 设为 `1` 使用合成测试画面，只支持观察。 |

### 桌面服务与本地会话

下表的 VNC 配置在启用桌面运维时读取。若基础镜像已提供环境变量，使用镜像值；表中列的是项目代码的回退值。

| 变量 | 默认值或来源 | 作用 |
| --- | --- | --- |
| `AVL_MANAGE_DESKTOP` | 本地关闭；容器入口固定为 `1` | 设为 `1` 启用进程探测和恢复。本地接入已有桌面时通常保持关闭；本地开启需准备镜像对应的运行目录、VNC 密码文件和运维程序。 |
| `AVL_SSHD_PORT` | `22` | 容器内 sshd 的监听与探测端口，整数 1–65535。SSH 登录使用桌面用户的 `authorized_keys` 公钥。 |
| `DISPLAY` | 回退为 `:1` | X11 采集、输入与桌面服务使用的显示号。本地沿用目标图形会话的值；容器接受如 `:1`、`:1.0` 的本地显示。 |
| `XAUTHORITY` | 本地沿用 X11 会话；容器入口设为 `/run/avl/desktop/Xauthority` | X11 授权文件路径。本地从目标图形会话取得；容器入口生成 cookie 和文件，无需填写 cookie。 |
| `XDG_RUNTIME_DIR` | 本地沿用会话；容器入口设为 `/run/avl/desktop` | 桌面用户的运行目录；受管 Xvnc 在此读取 `vnc.passwd`。 |
| `DBUS_SESSION_BUS_ADDRESS` | 本地沿用会话；容器入口设为 `unix:path=/run/avl/desktop/bus` | XFCE 会话总线地址，用于启动和探测 D-Bus。 |
| `NOVNC_HOME` | `/usr/libexec/noVNCdim` | noVNC 静态文件和 `utils/websockify/run` 所在目录。 |
| `VNC_PORT` | `5902` | Xvnc 的回环监听端口，也是 websockify 的上游端口。 |
| `NOVNC_PORT` | `6902` | 只读 noVNC 网页与 WebSocket 在容器内的回环监听端口。 |
| `VNC_RESOLUTION` | `1920x1080` | 受管 Xvnc 启动时的桌面宽×高。 |
| `VNC_COL_DEPTH` | `24` | 受管 Xvnc 的颜色深度（位），须受该 Xvnc 支持。 |

### 视觉模型与基准

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AVL_MODEL_WS` | `ws://127.0.0.1:3080/avl/model` | 视觉适配器连接 Host 的地址。仅回环地址允许明文 WS；跨机器用 `wss://域名/avl/model`。 |
| `AVL_OMNI_BASE_URL` | `http://127.0.0.1:8000/v1` | Omni 适配器使用的 OpenAI 兼容 API 根地址。适配器和定位评估会追加 `/chat/completions`。 |
| `AVL_OMNI_MODEL` | `Qwen/Qwen3-VL-8B-Instruct` | 推理服务实际发布的视觉模型 ID，同时用于定位评估。 |
| `AVL_SIM_INFERENCE_FPS` | `2` | 模拟器每秒发起后台视觉采样的上限，可取大于 0 且不超过 24 的小数。模型端仍持续接收视频。 |
| `AVL_BENCH_SECONDS` | `8` | 每个传输基准场景的测量秒数，至少 3 秒。 |
| `AVL_BENCH_DELAY_MS` | `35` | 基准延迟场景中注入的延迟，范围 0–1000 毫秒。 |
| `AVL_BENCH_DISPLAY` | 未设置，基准使用合成画面 | 设置为目标 X11 显示号即可测量真实桌面，配合该会话的 `XAUTHORITY`。 |
| `PYTHON` | `python3` | 传输基准启动模型子进程时使用的 Python 可执行文件。 |

**构建参数和内部值**：`DESKTOP_IMAGE` 是 Docker 构建参数，用 `docker build --build-arg DESKTOP_IMAGE=仓库名:标签 …` 选择基础镜像。`HEADLESS_USER_NAME` 来自该镜像，必须对应构建时配置过运维权限的非 root 桌面账号。`AVL_MODEL_TOKEN_FD` 由启动器管理，值 `3` 表示读取已打开的文件描述符。两者均无需手填。基础镜像遗留的 `SUDO_PW`、`ARG_SUDO_INITIAL_PW` 和 `VNC_PW` 在入口被移除。

## 运行验证

```bash
npm ci
npm run build
python3 -m pip install .
npm test
python3 -m unittest discover -s tests -v
node tests/benchmark.mjs
```

工作区测试会启动并重启临时 DSH。X11 测试使用单独显示号和认证 cookie。基准输出分别报告采集、模型接收、实际处理及延迟，还会检查订阅前后模型收到的视频帧数。真实模型的控件定位通过 `python3 -m model.evaluate --omni` 评估。在具备 Docker 的机器上运行 `python3 container/test-lifecycle.py avl-desktop:v2` 验证容器冷启动、故障修复和 DSH 退出行为。
