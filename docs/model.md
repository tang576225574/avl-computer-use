# 共享视觉服务与视频协议

## A、B、C 各自启动什么

| 位置 | 进程和连接 | 配置 |
| --- | --- | --- |
| A，每位用户自己的桌面容器 | DSH Host 插件运行 FFmpeg，在租约订阅期间通过出站 WS/WSS 发送二进制 JPEG；浏览器另外订阅自己的 A | `AVL_MODEL_WS` 指向 C；`AVL_MODEL_TOKEN` 只填分配给该桌面的值；`AVL_MAIN_*` 指向 B |
| B，主模型 | OpenAI 兼容 Chat Completions，接受流式文本与工具调用。DSH 负责拼接历史、发起工具和保存结果 | B 的 URL、模型 ID 和 API Key 配在 A |
| C，视觉模型 | 一个 `avl-model` 服务监听多路桌面连接，内嵌一套 vLLM V1 异步引擎，回传进度、单步观察和候选动作 | `AVL_MODEL_TOKENS` 列出所有允许接入的令牌；`AVL_OMNI_MODEL` 选择此实例的权重；无需 A 的地址 |

### 部署、分配凭据与升级

在兼容 vLLM 0.34.0 的 GPU 环境中运行以下命令。先按 README 为每台 A 生成独立令牌，将允许列表作为 JSON 数组注入 C。模型可用本地路径或已获访问权限的模型 ID。GPU 的驱动、运行时、显存和模型下载权限需要在 C 准备。[凭据示例](../README.md#先启动共享视觉服务机器-c) · [vLLM GPU 安装指南](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/)

```bash
python3 -m pip install '.[gpu]'
export AVL_OMNI_MODEL=Qwen/Qwen3-VL-8B-Instruct
avl-model --host 0.0.0.0 --port 8765 \
  --tls-cert /srv/avl/tls/chain.pem --tls-key /srv/avl/tls/key.pem
```

默认监听 `127.0.0.1:8765`。回环联调直接运行 `avl-model`。也可在 C 的回环服务前终止 TLS，代理须转发 Upgrade 和 Authorization。跨机器的 A 使用 `wss://vision.example.org:8765/avl/model`（有反向代理时使用代理的域名和端口）。A 按系统/Node 信任链校验证书，私有 CA 可在 A 的 Node 启动前用 `NODE_EXTRA_CA_CERTS` 指定可信 CA 文件。C 在身份验证成功前拒绝升级，401 表示凭据无效，409 表示同一令牌已有在线桌面。DSH owner 链接只在浏览器登录 A 时使用。

轮换时在 C 更新凭据列表并重启服务，给相应的 A 注入新令牌并重启。C 重启使所有在线 A 的视觉连接断开，A 自动重连；旧的步骤、租约和输入都不能重放。收回访问时从 C 的列表删除对应令牌并重启。升级旧部署时请使用同一版的 A 和 C，替换原先由模型机器拨向 Host 的连接配置。A 不再提供入站模型路由，C 不依赖独立的视觉 HTTP 推理服务。

### 内嵌推理和排队

C 每路连接维护独立的 `stream`、计数、步骤及最新候选帧，JPEG 使用接收消息的内存视图。接收循环持续读取桌面帧；同一桌面只有一个推理请求在途，另保留一张最新候选帧。共享调度器轮流从已就绪桌面取请求，`--max-concurrency` 默认 4，限制正在使用的推理槽数。每台桌面的后台采样率默认每秒 2 次，可用 `AVL_SIM_INFERENCE_FPS` 或 `--sample-fps` 调整。显式步骤抢占本桌面的后台观察，等待晚于 `afterSeq` 的画面，也要排队使用共享槽。等待超过本次订阅 `freshMs` 的帧在 C 被丢弃，A 在执行键鼠前仍按原始采集时刻校验新鲜度。

A 将帧头和 JPEG 拼成一条二进制消息；WebSocket 客户端掩码、TCP/TLS 与接收缓冲仍有开销。C 的接收视图避免为切出 JPEG 再拷贝整帧。引擎入口在线程中将选中的 JPEG 解码为 PIL 图像，使用模型的聊天模板渲染视觉系统提示、图像和单步指令，再以唯一请求 ID 调用异步生成。取消生成时按请求 ID 中止。这里省去了适配器到另一台视觉 HTTP 服务器的序列化和网络传输。vLLM 自身的视觉预处理、Engine Core 的请求调度、GPU 数据搬运和输出返回仍由引擎完成。一个引擎的前端、核心和 worker 可以是不同进程，部署时按一套引擎预算显存。[视觉提示和引擎代码](../model/engine.py) · [共享服务和调度器](../model/adapter.py)

`avl-model --benchmark` 使用相同的监听、认证和帧接收协议，只计收帧，`processed` 为零。该模式仅需 `python3 -m pip install .`。正常启动时缺少 GPU 依赖或模型加载失败会报错。运行中收到 SIGTERM 时，服务关闭监听及各路 WebSocket，取消推理，再释放引擎。若生成、渲染或取消请求时发现 vLLM 引擎已失效，C 会断开所有桌面并以状态 1 退出，便于服务管理器重启。空闲时引擎失效可能要到下一次推理才会发现。普通单步输出错误只影响对应桌面的那一步。

## 接入未来的逐帧模型

替换 C 的推理服务即可复用 A 的工具、观看和输入校验。现有 `simulator` 刻意抽帧；若实现 `full`，需将每路到达的有效帧送入自己的连续视觉状态更新，并报告**实际完成**的帧数。仅修改握手标记不会让抽帧引擎具备逐帧推理能力。

1. C 监听 `/avl/model`，A 在 Upgrade 请求中发送 `Authorization: Bearer <AVL_MODEL_TOKEN>`。C 验证身份、绑定独立连接，向 A 发送 `{"type":"hello","version":2,"mode":"full"}`。只收到控制消息时保持空闲。收到 A 的 `{"type":"start","stream":"…","freshMs":5000}` 后新建这一代订阅的状态和计数。
2. 从每个二进制消息读取 4 字节大端无符号头长度，之后为 UTF-8 JSON 和 JPEG 数据。头最长 1 KiB，单张 JPEG 最大 8 MiB。头含 `stream`、`seq`、`capturedMs`、`width`、`height`。序号在当前订阅内单调递增，跳号表示最新帧替换或传输中丢失的画面；接收数量逐张累加。
3. 用独立接收循环记录模型机器单调时钟的 `receivedMs`。在真实视觉状态完成后记录 `processedMs`。每约 250 ms 上报进度。计数和时间戳属于当前连接及采集代次。`processedSeq` 表示已有视觉状态的最近一帧，推理请求发出时不能提前计入。
4. 收到 `step` 时，使用同一订阅且序号大于 `afterSeq` 的已处理帧生成观察或动作。先发进度再返回带步骤 ID 和依据帧号的结果；`observeOnly` 为真时返回 `action:null`。超时或错误可返回同一 ID 的 `error`。模型只返回候选动作，Host 负责校验和执行。
5. `cancel` 取消指定步骤。收到 `stop` 后释放该订阅的未决任务和视觉状态，回到只收控制消息的状态。连接中断后释放该桌面的状态、取消引擎请求；A 重连时 C 重新发 hello，等待新任务。

进度示例，数值为模型端实际测量：

```json
{"type":"progress","stream":"s","seq":120,"measuredMs":8720.1,"received":118,"processed":115,"processedSeq":117,"sampled":118,"dropped":0,"samples":[{"seq":120,"receivedMs":8701.5},{"seq":117,"receivedMs":8582.7,"submittedMs":8588.2,"processedMs":8698.1}]}
```

`samples` 可先报告接收时间，再以同一帧号补充调度提交时间 `submittedMs` 和完成时间 `processedMs`。C 排队 P95 为同一帧的 `submittedMs - receivedMs`，包括抽帧等待与调度等待。报告的 `measuredMs` 使用模型单调时钟在统计快照时采集，用于计算模型侧的计数增量和时间间隔。毫秒时间戳取所在进程的单调时钟。Host 发送 `{"type":"ping","id":"p","t0":…}`，模型在收到及应答时记录 `t1`、`t2`，返回 `{"type":"pong","id":"p","t0":…,"t1":…,"t2":…}`。Host 据此估算两地时钟偏移，避免把两台机器的单调时间直接相减。

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

第一条在本机加载同一视觉引擎逐条预测（可传 `--model`），请预留独立 GPU 或先停止在线服务以释放显存；第二条在断网条件下给已有预测打分。预测文件是以样本 ID 为键、归一化点坐标为值的 JSON 对象，例如 `{"editor-1":[190,540]}`。评估报告包含 `hits`、`total`、`missing`、`hitRate` 和每条样本的结果。缺失、非法预测或推理失败均留在分母里。用 `--dataset <manifest.json>` 可切换到自己的标注桌面集。内置小样本用来检验坐标协议与回归，不代表真实业务精度。

## 可复现的传输基准

安装前端与 Python 测试依赖后运行 `node tests/benchmark.mjs`。脚本在临时目录启动真实 DSH、独立 FFmpeg、已认证的面板连接及 C 的 Python 服务，覆盖 12 fps、24 fps、双向延迟、模拟慢推理、两台独立 Host 共享 C 五组场景。慢推理用测试替身等待约 100 ms 并回显当步指令。双桌面场景将共享并发上限设为 1，验证两边分别收到自己的结果，并在关闭第一台 Host 后验证另一台继续收帧及完成步骤。慢推理的单桌面用例还在活跃租约期间重启 C，验证网页继续收帧、旧租约失效、A 自动重连并凭新租约重新观察。每组验证未订阅零发帧、停止后不再给 C 送帧，以及浏览器能继续观看。

`AVL_BENCH_SECONDS` 调整采样时长（默认 8 秒），`AVL_BENCH_DELAY_MS` 调整延迟场景每个方向增加的毫秒数（默认 35）。`payloadMbps` 只计二进制消息的 JPEG 及项目协议头；`rxP95` 的起点为 Host 收齐 FFmpeg 编码结果，终点为 C 收齐帧，跨机校时误差过大时该指标留空。浏览器解码与渲染、屏幕内容变化到编码结束的时间需独立测量。要测试自己的 X11 分辨率与负载，可在专用桌面播放代表性的动态内容，再运行：

```bash
AVL_BENCH_DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" node tests/benchmark.mjs
```

### 本次 CPU 回环结果

下表使用 640×360 FFmpeg 动态合成图，每组测量 8 秒。双桌面分别运行 DSH 和 FFmpeg，同时连接同一个 C。FPS 取最后一个滚动窗口，单次运行的抖动和丢帧可从原始 JSON 的 `sequenceGaps` 观察。

| 场景 | C 实收 fps | 接收 P95（ms） | C 排队 P95（ms） | 完成推理 fps |
| --- | ---: | ---: | ---: | ---: |
| 12 fps 仅接收 | 11.96 | 26.53 | — | 0 |
| 24 fps 仅接收 | 24.10 | 1.36 | — | 0 |
| 24 fps，两个方向各加 35 ms | 23.90 | 36.74 | — | 0 |
| 24 fps，100 ms 模拟推理 | 23.90 | 1.39 | 14.24 | 1.99 |
| 双桌面 A1，共享一个模拟推理槽 | 23.89 | 1.39 | 45.79 | 1.99 |
| 双桌面 A2，同一时段 | 23.89 | 2.58 | 42.06 | 1.99 |

双桌面到视觉状态的 P95 分别为 147.72 和 143.06 ms，两路都没有接收序号缺口。单路 24 fps 仅接收和注入延迟两组分别有 1 和 3 个序号缺口。真实 GPU、屏幕分辨率和公网状况会改变这些结果。

另在隔离的 1920×1080 Xvnc 上播放全屏 24 fps 动态测试图，用正式 `x11grab` 路径重复五组测试。双 Host 同时采集这一测试显示、各自持有独立令牌和租约，C 实收 **23.91 / 24.06 fps**，接收 P95 **4.43 / 4.22 ms**，每路有效负载约 **23.3 Mbit/s**。单路 24 fps、双向各注入 35 ms 的场景，接收 P95 为 **40.89 ms**。此处经过本机测试延迟桥；生产路径由 A 直连 C。

### 在 GPU 机器上验收

1. 在 C 运行 `avl-localize --omni`，记录控件定位命中率与缺失数。结束评估后启动正常推理服务。
2. 配置两个独立令牌，在 A1、A2 上启动 Host，分别让 Agent 观察不同的桌面。记录每路采集、接收和推理完成 FPS，接收、排队、帧到视觉状态 P95 以及校时误差。让两台桌面都发步骤，核对画面、指令和结果归属。
3. 结束 A1 的任务，A2 应继续接收和推理。再重启 C，确认 A2 的旧步骤被撤销，浏览器能继续观看；重连后用新租约先观察，再执行输入。
4. 在实际分辨率、公网带宽和预期用户数下分别验证接收下限 12 fps 与设计目标 24 fps。对未来逐帧模型同时核对 `processedFps`、积压和动作新鲜度；模拟器完成率受抽帧上限影响。
