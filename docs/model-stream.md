# 模型视频流协议 v1

桌面服务在 `/v1/model` 提供 WebSocket。模型客户端用 HTTP Authorization 头连接，建立后在 5 秒内发送 JSON 握手消息。

```json
{"type":"hello","v":1,"mode":"full"}
```

`mode` 可为 `full` 或 `simulator`。生产全帧模型用 `full`。

## 桌面服务发给模型

每条二进制消息是一张 JPEG。前四字节是无符号大端 JSON 头长度，之后是 UTF-8 JSON 头，余下字节是 JPEG。头最大 1024 字节，JPEG 最大 8 MiB。可以直接复用 `avl_computer_use.backend.wire.decode_frame`。

```json
{"v":1,"stream":"capture-generation-id","seq":144,"captured_ns":291236570012,"width":1920,"height":1080}
```

同一 `stream` 的 `seq` 从 1 递增，`captured_ns` 是桌面进程的单调时钟，可用于计算帧间隔。采集重启后生成新 `stream`，模型丢弃之前流的视觉状态和未决任务。控制消息为 WebSocket 文本 JSON。

```json
{"type":"start","id":"job-id","instruction":"点击保存按钮","stream":"capture-generation-id","after_seq":144,"observe_only":false}
```

```json
{"type":"cancel","id":"job-id"}
```

`start` 和 `cancel` 与视频帧交错到达。慢推理需要独立执行，接收循环持续读取帧。每个接收端有独立的发送状态。尚未发送的 JPEG 会被新帧覆盖，因此 `seq` 可以跳号，接收与处理计数应按实际收到和完成的帧累加。控制消息使用独立的有界队列并按顺序发送。正在写入 WebSocket 的消息超过发送端设置的 `AVL_STREAM_WRITE_TIMEOUT_MS`（单位毫秒，默认 `1000`）仍未发送完成，或者控制队列溢出时，该连接关闭，由模型重新连接到实时位置。

## 模型发给桌面服务

每约 250 ms 推送一次进度，持续送到最后一个实际接收并已编码的帧。计数在单个 WebSocket 生命周期内单调递增，帧序号随采集 `stream` 重置。采集重启期间可等到新流第一帧处理完再报告。进度回执或最近编码帧超过 1.5 秒时，Agent 暂停操作。服务器在 5 秒无客户端消息后关闭连接。实时门槛按 12 fps 设计，滚动测量允许 0.2 fps 的调度波动。

```json
{"type":"progress","stream":"capture-generation-id","seq":150,"received":150,"processed":149,"processed_seq":149}
```

- `seq` 为最后收到的帧序号，`received` 为收到的总帧数。
- `processed_seq` 为当前采集代最后实际完成视觉编码的帧序号，`processed` 为实际编码帧总数。
- Qwen 模拟器另报 `sampled`、`dropped`、`started`。它的 `processed` 统计完成的 Qwen 调用。

当模型已经上报了决策所依据的编码帧，返回一个 `result`。

```json
{"type":"result","id":"job-id","stream":"capture-generation-id","seq":149,"decision":{"observation":"保存按钮可见","action":{"kind":"click","x":820,"y":924,"button":1}}}
```

`seq` 必须大于请求的 `after_seq`，且不能大于已经上报的 `processed_seq`。坐标相对整张图像，左上角为原点，取值 0–1000。可返回 `click`、`key`、`type`、`scroll`，或用 `action: null` 表示完成、仅观察或没有把握。只观察请求由桌面服务强制禁止发送输入。无效模型输出或推理错误可返回带 `error` 的结果。

```json
{"type":"result","id":"job-id","stream":"capture-generation-id","seq":149,"error":"视觉模型暂时无法完成本次观察"}
```

新 WebSocket 连接只处理新任务。断开前尚未确认的输入不重放。恢复后先确认新鲜视觉状态，再接受工具调用。
