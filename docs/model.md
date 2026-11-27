# 视觉模型端

视觉服务运行在模型所在机器。它主动连接 DSH Host 的 `/avl/model`，每个桌面同时接受一个视觉端。空闲时连接只处理控制消息。浏览器单独观看桌面也不会给模型推帧。

## 启动 Omni 视觉模拟器

Omni 是本项目视觉适配器的名称。`AVL_OMNI_MODEL` 应填写推理服务实际发布的模型 ID。适配器需要 Python 3.11+ 和支持图像输入的 OpenAI 兼容推理接口。在模型机器上安装本项目 Python 包，并设置 Host 部署分配的视觉令牌。跨机器用 WSS，开发机回环测试可用 WS。

```bash
python3 -m pip install .
export AVL_MODEL_WS=wss://desktop.example/avl/model
export AVL_MODEL_TOKEN='<视觉连接令牌>'
export AVL_OMNI_BASE_URL=http://127.0.0.1:8000/v1
export AVL_OMNI_MODEL=Qwen/Qwen3-VL-8B-Instruct
export AVL_SIM_INFERENCE_FPS=2
python3 -m model.adapter
```

单次启动时也可以用 `--omni-url` 覆盖推理 API 根地址，用 `--model` 覆盖模型 ID。`--url` 指定适配器连接 DSH Host 的 WebSocket 地址。

若推理端需要认证，设置 `AVL_OMNI_API_KEY`。任务开始后，接收循环持续读取 JPEG，默认每秒最多发起两次后台视觉采样。已有推理尚未完成时丢弃后续待推理样本；收到步骤时取消普通观察，优先选取满足 `afterSeq` 的新帧。HTTP 端实际完成次数单独统计。只观察步骤强制清空动作。停止任务、重新订阅或断开连接会丢弃任务上下文。

只测视频传输时运行 `python3 -m model.adapter --benchmark`。该客户端完整接收 JPEG 并回执，不调用 Omni。`received` 可以作为吞吐基准，`processed` 保持 0。链路测试与真实模型推理应分别报告。

## 接入自部署模型

1. WSS Upgrade 请求携带 `Authorization: Bearer <AVL_MODEL_TOKEN>`。连接后发送 `{"type":"hello","version":2,"mode":"full"}`。DSH 发送 `{"type":"start","stream":"…"}` 时，重置接收与处理计数。
2. 从每个二进制消息读取 4 字节大端无符号头长度，之后为 UTF-8 JSON 和 JPEG 数据。头最长 1 KiB，单张 JPEG 最大 8 MiB。头含 `stream`、`seq`、`capturedMs`、`width`、`height`。序号在当前订阅内单调递增，跳号表示最新帧替换或传输中丢失的画面；接收数量逐张累加。
3. 用独立接收循环记录模型机器单调时钟的 `receivedMs`。在真实视觉状态完成后记录 `processedMs`。每约 250 ms 上报进度。计数和时间戳属于当前连接及采集代次。`processedSeq` 表示已有视觉状态的最近一帧，推理请求发出时不能提前计入。
4. 收到 `step` 时，使用同一订阅且序号大于 `afterSeq` 的已处理帧生成观察或动作。先发进度再返回带步骤 ID 和依据帧号的结果；`observeOnly` 为真时返回 `action:null`。超时或错误可返回同一 ID 的 `error`。模型只返回候选动作，Host 负责校验和执行。
5. `cancel` 取消指定步骤。收到 `stop` 后释放该订阅的未决任务和视觉状态，回到只收控制消息的状态。连接中断后重新握手，等待新任务。

进度示例，数值为模型端实际测量：

```json
{"type":"progress","stream":"s","seq":120,"measuredMs":8720.1,"received":118,"processed":115,"processedSeq":117,"sampled":118,"dropped":0,"samples":[{"seq":120,"receivedMs":8701.5},{"seq":117,"receivedMs":8582.7,"processedMs":8698.1}]}
```

`samples` 可先报告接收时间，再以同一帧号补充完成时间。报告的 `measuredMs` 使用模型单调时钟在统计快照时采集，用于计算模型侧的计数增量和时间间隔。毫秒时间戳取所在进程的单调时钟。Host 发送 `{"type":"ping","id":"p","t0":…}`，模型在收到及应答时记录 `t1`、`t2`，返回 `{"type":"pong","id":"p","t0":…,"t1":…,"t2":…}`。Host 据此估算两地时钟偏移，避免把两台机器的单调时间直接相减。

```json
{"type":"step","stream":"s","id":"job","afterSeq":120,"instruction":"Click Save","observeOnly":false}
{"type":"result","stream":"s","id":"job","seq":126,"observation":"Save button visible","action":{"kind":"click","x":860,"y":801,"button":"left"}}
```

坐标原点为左上角，范围 0–1000。移动和点击用 `x,y`，滚动用鼠标位置 `x,y` 和有符号步数 `dy`（正数向下），按键用 `key`，输入文字用 `text`。完成率、定位命中率与接收帧率分别计算。

## 离线控件定位评测

内置三张确定性 UI 画面、九个点击目标，覆盖设置、编辑器和文件选择界面。标注矩形使用左闭右开的像素边界。全量测试画面的每条指令只给视觉模型原图和控件名称，坐标真值只供评分程序读取。

```bash
python3 -m model.evaluate --omni
python3 -m model.evaluate --predictions predictions.json
```

第一条让已配置的 Omni 逐条预测，第二条在断网条件下给已有预测打分。预测文件是以样本 ID 为键、归一化点坐标为值的 JSON 对象，例如 `{"editor-1":[190,540]}`。评估报告包含 `hits`、`total`、`missing`、`hitRate` 和每条样本的结果。缺失、非法预测或推理失败均留在分母里。用 `--dataset <manifest.json>` 可切换到自己的标注桌面集。内置小样本用来检验坐标协议与回归，不代表真实业务精度。

## 可复现的传输基准

从仓库根目录完成 Node 与 Python 依赖安装后，运行 `node tests/benchmark.mjs`。脚本在临时目录启动真实 DSH Web、仅向该测试实例注册的工具驱动、FFmpeg 640×360 测试画面、已认证的前端观看连接和独立 Python 模型进程。开发机无需有 X11 显示或 sudo 权限。脚本逐次输出一行 JSON，四组配置分别为 12 fps 接收器、24 fps 接收器、24 fps 模拟网络延迟和 24 fps 真实适配器连接模拟 Omni HTTP 接口。测试默认每组采样 8 秒，`AVL_BENCH_SECONDS` 可调整采样时间，`AVL_BENCH_DELAY_MS` 可调整网络用例每个方向增加的毫秒数。

每组断言模型空闲时没有视频、工具开启后开始收帧、工具结束后模型再次停止收帧且浏览器继续观看。延迟桥仅用于本机测量。模拟 Omni 将每个 HTTP 响应延迟约 100 ms，验证持续收帧和独立推理；真实模型耗时需要部署后单独报告。`payloadMbps` 是模型链路的 JPEG 及其协议头带宽，排除握手和 TLS/TCP 开销。计时起点为 Host 收齐该帧 JPEG 的时刻，包含后续分发与网络延迟。屏幕变化到 FFmpeg 产出 JPEG 的时间与浏览器绘制时间需另测。

2026-11-23 在本容器的回环实测如下。分位数来自各次运行的帧样本，FPS 为最后一次状态报告的滚动值。三组接收器测试的处理帧数为零，四组均未观察到接收序号缺口。

| 配置 | 采集 FPS | 接收 FPS | 接收延迟 P95 | 模型链路 Mbps | 完成推理 FPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 12 fps 接收器 | 11.92 | 12.13 | 1.59 ms | 1.72 | 0 |
| 24 fps 接收器 | 23.96 | 23.88 | 1.49 ms | 3.45 | 0 |
| 24 fps，双向各增加 35 ms | 23.89 | 24.08 | 36.83 ms | 3.45 | 0 |
| 24 fps，模拟 Omni HTTP 响应约 100 ms | 23.87 | 24.10 | 1.61 ms | 3.45 | 1.79 |

延迟注入组的时钟估计误差上界为 35.86 ms；模拟 Omni 组的帧到视觉状态 P95 为 111.27 ms，Host 收到该状态回执的 P95 为 346.10 ms。该组最后一个统计窗口显示累积接收 200 帧、完成 16 次推理、主动丢弃 184 帧。测试计入模型端大约每 250 ms 批量回报进度所产生的回执等待。

另在独立的 1920×1080 Xvnc 显示上播放全屏 24 fps 动态测试图，使用正式的 `x11grab` 采集路径复测。回环目标 24 fps 时，模型实收 **23.87 fps**，JPEG 完成至收帧的 P95 为 **2.03 ms**，模型方向的有效负载约 **25.66 Mbit/s**。每个方向注入 35 ms 后，实收 **23.90 fps**，P95 为 **37.58 ms**，校时误差上界为 35.07 ms。100 ms 模拟推理用例实收 **24.10 fps**，实际完成 **1.79 次/秒**，帧到视觉状态 P95 为 **113.85 ms**。四组都通过了空闲零帧、停止后零新增帧、浏览器继续观看的断言。

要在自己的测试桌面复测，先在专用 X11 显示上准备有代表性的动态画面，再运行下列命令。`DISPLAY` 和 `XAUTHORITY` 在命令中指向该测试显示。基准仅执行观察步骤；输出包含特定分辨率和桌面内容下的实际带宽。

```bash
AVL_BENCH_DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" node tests/benchmark.mjs
```
