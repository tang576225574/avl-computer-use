# AVL Computer Use

在 DSH 聊天中让 Agent 操作容器里的 XFCE 桌面。操作者可以打开右侧「桌面控制台」观看、接管键鼠，再把控制权交还给 Agent。桌面和 DSH Host 共用一个容器、本地文件系统和 X11 显示。插件使用 DSH 的 Web 服务、会话和工具接口，使用 DSH 原生本地工作区，可同时保留多个项目和对话。所有工作区的主 Agent 与子 Agent 共用一条桌面队列，按申请顺序获得控制权。

- 阅读源码从[架构图、文本时序和故障行为](docs/architecture.md)开始。
- 部署桌面镜像、配置外网地址和了解进程恢复见[容器运行手册](docs/container.md)。
- 部署 Omni 视觉适配器、接入未来的逐帧模型和复现延迟测量见[模型协议与基准](docs/model.md)。

## 先启动共享视觉服务（机器 C）

一台 GPU 机器可以服务多个独立桌面。每个桌面 A 主动连接 C，在 Agent 取得桌面租约期间发送 JPEG。C 的 WebSocket 服务直接调用同一套内嵌 vLLM 引擎。默认视觉模型为 `Qwen/Qwen3-VL-8B-Instruct`。主模型 B 单独提供支持流式工具调用的 Chat Completions，供 DSH 处理聊天和任务规划。启动顺序推荐 C、B、A。A 可以先启动，视觉服务上线后会自动连接。

在 C 的 GPU 环境中安装依赖。下面的 Bash 示例在首次部署时为两台桌面各生成一份随机凭据。请将每个文件的内容通过凭据管理系统只交给对应桌面管理员，重启服务时继续读取原文件。

```bash
python3 -m pip install '.[gpu]'
umask 077
mkdir -p "$HOME/.config/avl/tokens"
for id in desktop-1 desktop-2; do
  file="$HOME/.config/avl/tokens/$id"
  if [[ ! -e "$file" ]]; then (set -C; openssl rand -hex 32 > "$file"); fi
done
```

在 C 上启动服务，证书需覆盖桌面使用的域名。纯本机联调可省略四个监听和证书参数，默认监听回环地址 8765。

```bash
export AVL_MODEL_TOKENS="$(python3 -c 'import json,pathlib; print(json.dumps([p.read_text().strip() for p in sorted((pathlib.Path.home()/".config/avl/tokens").glob("desktop-*")) if p.is_file()]))')"
export AVL_OMNI_MODEL=Qwen/Qwen3-VL-8B-Instruct
avl-model --host 0.0.0.0 --port 8765 \
  --tls-cert /srv/avl/tls/chain.pem --tls-key /srv/avl/tls/key.pem
```

要调整 C 的显存预算，在原启动命令末尾追加 `-- --gpu-memory-utilization 0.8`。独立的 `--` 后面可以继续写 vLLM 原生引擎参数，例如双卡部署的 `--tensor-parallel-size 2`。运行 `avl-model -- --help=all` 可查看当前安装版本支持的引擎参数。参数在 C 启动时对所有连接生效。[双卡启动示例与模型选择顺序](docs/model.md#在-c-上配置-vllm-引擎)

如需先验证网络，可在普通 CPU 机器上安装 `python3 -m pip install .`，给同一个启动命令加 `--benchmark`，控制台即可显示实际接收帧率。真实视觉推理、逐帧模型接入和双桌面验收见[模型协议与基准](docs/model.md)。

## 启动桌面容器

在 A 的 Docker 宿主机上准备本地运维密码以及 C 分配给这台桌面的模型令牌，然后从当前源码构建镜像。下例使用 C 的公网 WSS 地址，DSH 网页只发布到 A 宿主机的回环地址。

```bash
read -rsp '本地运维 sudo 密码：' AVL_SUDO_PASSWORD; echo
read -rsp 'C 分配给本桌面的令牌：' AVL_MODEL_TOKEN; echo
export AVL_SUDO_PASSWORD AVL_MODEL_TOKEN
export AVL_MODEL_WS=wss://vision.example.org:8765/avl/model
docker build -t avl-desktop:v2 .
docker run --name avl -p 127.0.0.1:3080:3080 \
  -e AVL_SUDO_PASSWORD -e AVL_MODEL_TOKEN -e AVL_MODEL_WS \
  -e AVL_MAIN_BASE_URL -e AVL_MAIN_MODEL -e AVL_MAIN_API_KEY \
  -e DSH_PUBLIC_URL=http://127.0.0.1:3080 \
  -v avl-ssh-hostkeys:/var/lib/avl-sshd \
  avl-desktop:v2
```

可在运行上述命令前导出主模型三项配置，或稍后在 DSH 中选择主模型。升级旧部署时请同时更新 A、C，把原先指向桌面的模型地址改为指向 C。容器内的 `127.0.0.1` 指容器自身。

**SSH 主机密钥挂载是可选的。** 只通过 DSH 网页使用桌面时，可以省略示例中的 `-v avl-ssh-hostkeys:/var/lib/avl-sshd`。如果还通过 SSH 登录，保留挂载可以让客户端在容器重建后继续识别同一台服务器。

- 左侧 `avl-ssh-hostkeys` 是 Docker 命名卷，名称可自定。重建同一服务时复用原卷即可。
- 右侧 `/var/lib/avl-sshd` 是当前容器入口固定使用的目录。入口在这里读取 `host_ed25519`，文件缺失时自动生成。用户登录用的公钥另存于桌面用户的 `~/.ssh/authorized_keys`。
- 省略挂载后，`docker restart avl` 重启同一个容器仍会保留密钥。删除容器再新建时，如果未保留该目录，服务器会生成新密钥，曾连接同一地址和端口的 SSH 客户端会提示指纹已变化。

打开启动日志中带登录凭证的 DSH 链接，在 DSH 中选择本地工作目录和支持工具调用的主模型。需要保留对话和文件时，持久化桌面用户的 `DSH_HOME` 和工作目录。容器每次启动时由插件启动并监控桌面。DSH 退出后，tini 返回子进程退出状态，容器随之停止。

远程访问网页时，将 `DSH_PUBLIC_URL` 设为浏览器实际访问的 HTTPS 根地址。只有 A 需要能访问 C 的模型端口，C 无需访问 A 的网页端口。启动参数、持久卷和验收脚本见[容器运行手册](docs/container.md)。

## 完成一次桌面任务

连接成功后，正常推理服务在控制台显示 `simulator`。在 DSH 发送「打开设置，把界面语言改成中文」。主模型调用 `desktop_stream_start` 排队，获准后得到 `leaseId`。每次 `desktop_step` 以及最后的 `desktop_stream_stop` 都要带上这个标识。首次或视频空闲停送后先用 `observe_only: true` 观察。浏览器显示持有者和排队数，需要介入时点击「中断并接管」。Host 通知被中断的 Agent 及其所属主 Agent，确认在途键鼠停止后才允许网页输入。点击「交还 Agent」后，队首获得新的租约。

**模型配置按进程生效。** A 的 `AVL_MAIN_BASE_URL` 和 `AVL_MAIN_MODEL` 指向 B 的 HTTP(S) API 和模型 ID。新会话使用名为 `AVL Main` 的默认路由，已有会话可在模型选择器切换。A 的 `AVL_MODEL_WS` 和 `AVL_MODEL_TOKEN` 决定桌面连接哪台 C。视觉权重由 C 启动时的 `AVL_OMNI_MODEL` 选择，由一个引擎实例在多路桌面之间调度。C 的模型进程负责推理，无需额外启动视觉 HTTP 服务。主模型接口、工具调用和 DSH 自身网页接口见[DSH 接口说明](docs/dsh-api.md)。

## 在已有桌面上开发

需要 Node.js 24.9+、npm、FFmpeg 和 xdotool。安装依赖并构建 React 面板后，启动脚本会从独立运行目录启动 DSH，配置从启动进程的环境传入。默认监听回环地址 3080，默认关闭本机桌面运维。首次运行可以选择测试画面，只观察而不触碰当前显示器。

```bash
npm ci
npm run build
read -rsp '模型连接令牌：' AVL_MODEL_TOKEN; echo
export AVL_MODEL_TOKEN
AVL_SYNTHETIC=1 ./tools/dsh.sh
```

要操作现有桌面，确保启动用户的 `DISPLAY` 和 `XAUTHORITY` 可以访问目标显示器，运行 `./tools/dsh.sh`。视觉服务按上文在 C 启动。本地联调可在同一机器的另一个终端启动。默认的 DSH 状态路径是 `$HOME/.local/state/avl-dsh`，可用绝对路径 `DSH_HOME` 覆盖。容器注入的 sudo 密码只由容器入口消费，本地开发命令使用没有该变量的 shell。

### 在运行中的容器内手动启动 Host

只从容器内访问时可用 `DSH_BIND=127.0.0.1`。若要从宿主机访问，请绑定容器用于接收端口转发的具体接口 IP。DSH 拒绝 `0.0.0.0` 和 `::` 这类通配地址，因为它们会把具备命令执行能力的 Host 暴露在所有接口上。以下示例假设容器已映射 `-p 127.0.0.1:8013:8013`，浏览器在宿主机打开。请先按上文设置 `AVL_MODEL_TOKEN`。

```bash
unset AVL_SUDO_PASSWORD
export DSH_BIND="$(python3 -c 'import socket; print(socket.gethostbyname(socket.gethostname()))')"
export DSH_PORT=8013
export DSH_PUBLIC_URL=http://127.0.0.1:8013
AVL_SYNTHETIC=1 ./tools/dsh.sh
```

多网卡容器可从 `hostname -I` 的结果中选择承接转发的地址，显式填写 `DSH_BIND`。浏览器经反向代理访问时，`DSH_PUBLIC_URL` 填浏览器实际使用的 HTTPS 根地址。使用本项目镜像入口启动时，它会自动选择容器 IP；若保持内部默认端口 3080，可以直接在宿主机映射 `-p 127.0.0.1:8013:3080`。首次访问使用启动日志中的 owner 链接。

## 环境变量

[.env.example](.env.example) 列出本项目启动器、插件、视觉适配器和基准程序读取的配置。A 的桌面容器启动需要 `AVL_SUDO_PASSWORD` 和 `AVL_MODEL_TOKEN`，本地直接启动 Host 只需后者。C 位于另一台机器时，还需在 A 设置 `AVL_MODEL_WS`。C 另设 `AVL_MODEL_TOKENS`。前端随 Host 提供，浏览器无需配置环境变量。

### 如何传入

- **桌面容器**：在宿主机执行 `(umask 077 && mkdir -p .local && cp -n .env.example .local/desktop.env)`，填写两项必填凭据和指向 C 的地址，按需启用容器配置。保持模型端和基准配置为注释。在上面的 `docker run` 命令中以 `--env-file .local/desktop.env` 替换对应的 `-e` 参数。Docker 环境文件按 `名称=值` 填写，直接写值，不加 shell 引号，也不写命令替换。
- **本地 Host / 模型机器**：分别在启动对应进程的 shell 中用 `export` 或上面的 `read -rsp` 设置。每个 Host 只持有自己的令牌，C 持有允许接入的完整列表。主模型服务的 API Key 交给 DSH Host；本地直接运行 `./tools/dsh.sh` 时须取消 `AVL_SUDO_PASSWORD`（即使空值也请 `unset AVL_SUDO_PASSWORD`）。这两个启动入口都无需读取仓库根目录的 `.env`。实际凭据文件请保存在版本控制之外。
- **DSH 网页登录**：由 DSH 生成 owner 登录链接。部署者可从 `docker logs avl` 或本地启动终端取得。该链接只交给网页操作者。模型服务的配置弹窗由 `AVL_MODEL_SETUP_PROMPT` 控制。

### 凭据与来源

| 变量 | 配置位置 / 默认值 | 谁设置、从哪里取得、用于什么 |
| --- | --- | --- |
| `AVL_SUDO_PASSWORD` | 桌面容器必填，无默认值 | **部署者自定义**，启动时入口将它设为本地运维账号 `avl-ops` 的新密码，用于固定的 sshd 恢复操作。无需从旧容器获取。单行、非空、最多 512 字节；与模型令牌不同。 |
| `AVL_MODEL_TOKEN` | A 必填 | **C 管理员生成并单独分发**。本桌面连接 C 时发送的 Bearer 令牌，用无空白的随机 ASCII 串，最多 512 字节。同一令牌只允许一个在线 Host。 |
| `AVL_MODEL_TOKENS` | C 必填 | **C 管理员自定义**的 JSON 字符串数组，每台 A 一个独立随机值。启动时验证列表，变更后重启 C 并更新对应 A。仅向 A 分发它自己的值。 |
| `AVL_NOVNC_PASSWORD` | 桌面容器可选，空或未设时每次启动随机生成 8 位 | **部署者可自定义**，6–8 个可打印 ASCII 字符，须区别于本地运维密码和本桌面模型令牌。仅供独立的只读 VNC/noVNC 观看。日常 DSH 面板无需此密码；需要单独登录 VNC 时，启动前指定并保存已知值。入口只写 VNC 密码文件，不输出随机值。 |
| `AVL_MAIN_API_KEY` | DSH Host，配置自定义主模型时使用 | 填主模型服务商签发或自部署管理员配置的 Key。无鉴权服务可留空，启动器向该路由提供固定的 `local-no-auth` 占位值以满足客户端要求。生成的 profile 仅保存变量名。 |

### DSH Host 与桌面视频

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DSH_BIND` | 本地 `127.0.0.1`；容器取自身主机名解析出的 IP | DSH 实际监听地址。Docker 端口映射需要能访问该容器接口。 |
| `DSH_PORT` | `3080` | DSH 网页和桌面面板的监听端口。修改后同步调整浏览器端口映射。 |
| `DSH_PUBLIC_URL` | 未设置 | 浏览器访问的 HTTP(S) 根地址，启动器据此设置信任的 Host。只填协议、主机及可选端口；域名、协议和端口应与对外入口一致。 |
| `DSH_HOME` | `$HOME/.local/state/avl-dsh` | DSH 状态、会话和启动目录。覆盖时填当前运行环境内的可写绝对路径；容器部署可挂载持久卷。 |
| `AVL_MAIN_BASE_URL` | 未设置 | 新会话默认主模型的 HTTP(S) API 根地址（例如 `http://inference:8000/v1`），与 `AVL_MAIN_MODEL` 一起设置。不要加 `/chat/completions`。启用时启动配置覆盖 DSH 的 `llm-pi-ai` 提供方配置及默认模型选择；如需继续使用网页管理的其他同类路由，取消这组主模型环境变量后重启。 |
| `AVL_MAIN_MODEL` | 未设置 | 主模型服务实际提供的模型 ID。未配置主模型时沿用 DSH 的模型设置。 |
| `AVL_MODEL_SETUP_PROMPT` | 配置了上述主模型时关闭，否则沿用 DSH | `0` 关闭网页自动弹出的模型账号/API Key 引导，`1` 启用原生引导。仍可手动打开设置，网页访问仍需 owner 登录。 |
| `AVL_MODEL_WS` | `ws://127.0.0.1:8765/avl/model` | A 主动访问的 C 服务地址。仅回环允许明文，跨机器用 WSS。 |
| `NODE_EXTRA_CA_CERTS` | 未设置 | 可选的 Node.js 信任 CA 文件。C 使用私有 CA 时挂载证书并在启动 A 前设置容器内路径。 |
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
| `AVL_OMNI_MODEL` | `Qwen/Qwen3-VL-8B-Instruct` | C 加载的模型 ID 或本地权重路径。离线定位评估也读取此值。 |
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
python3 -m pip install '.[test]'
npm test
python3 -m unittest discover -s tests -v
node tests/benchmark.mjs
```

工作区测试会启动并重启临时 DSH。X11 测试使用单独显示号和认证 cookie。基准输出分别报告采集、模型接收、实际处理及延迟，还会检查订阅前后模型收到的视频帧数。真实模型的控件定位通过 `python3 -m model.evaluate --omni` 评估。在具备 Docker 的机器上运行 `python3 container/test-lifecycle.py avl-desktop:v2` 验证容器冷启动、故障修复和 DSH 退出行为。
