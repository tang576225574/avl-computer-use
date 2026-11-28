# DSH 网页接口与主模型接口

适用于本项目锁定的 DSH `0.2.2-rc.5`、`web` profile、AVL 桌面插件以及由 `AVL_MAIN_BASE_URL` 配置的 `openai-completions` 主模型路由。下面的接口数随 DSH 版本和所装插件变化。

| 谁调用谁 | 地址示例 | 接口提供方 |
| --- | --- | --- |
| 浏览器 → DSH Host | `POST /api/llm/listProviders`、`POST /api/agentPresets/list`、WebSocket `/api/remote.mux` | DSH，管理会话、模型提供方、预设、插件和事件 |
| DSH Host → 主模型 | `POST /v1/chat/completions`，请求携带模型 ID、历史消息、流式开关及本轮可用的工具 | vLLM 或兼容服务 |
| DSH 模型设置 → 自定义推理服务 | 主动发现模型时可请求 `GET /v1/models` | vLLM 或兼容服务；启动器显式登记了模型 ID，常规对话无需这项发现操作 |
| C 的视觉适配器 → 内嵌 vLLM | Python 多模态引擎接口，图像及单步指令 | C 进程加载共享的视觉引擎 |
| DSH Host → C 建立双向连接 | WebSocket `/avl/model`，传输桌面帧、步骤、结果和进度 | AVL 桌面插件和适配器，用于桌面视频协议 |

`/v1` 是示例中 API 根地址的路径。浏览器访问 `DSH_PUBLIC_URL`，Host 访问 `AVL_MAIN_BASE_URL`。如果推理服务日志里出现 `/api/llm/listProviders` 或 `/api/agentPresets/list`，检查网页源地址和反向代理的 `/api/` 上游，包括 WebSocket Upgrade。[项目启动器](../tools/dsh.sh) · [视觉适配器](../model/adapter.py)

## 实际登录首页时调用了哪些接口

使用干净的临时 DSH 状态目录和浏览器配置，配置了自定义主模型，使用 owner 链接打开首页，未点击设置或发送消息。在页面导航后的 15 秒内，对发往本地 Host 的 HTTP 方法路径及 WebSocket 逻辑流去重，观察到 **10 个普通 RPC、4 个业务订阅和 1 个网关事件订阅**。

- **普通 RPC**：`agentPresets/list`、`credentials/describe`、`dynamicCordisRunner/inventory`、`dynamicCordisRunner/syncInspectManifest`、`permissionPresets/catalog`、`session/list`、`session/modelCatalog`、`settings/describe`、`web/listProviders`、`workspace/initializeDefault`。
- **流订阅**：`$events`、`account/watch`、`remoteAccess/follow`、`session/control`、`workspace/follow`。

其中 `web/listProviders` 用于网页搜索或抓取提供方，`llm/listProviders` 用于模型提供方。后者已在 Host 注册，本次首页记录中没有触发；打开设置、插件或已有会话会产生另一组调用。浏览器加载静态插件模块也会产生 HTTP 请求。

## Host 业务 RPC 全清单

在运行中的临时 Host 读取 Typert 的本地方法描述符，并与 Gateway 根据活动服务收集的 Remote 方法取并集、去重、核对服务是否存在。共 **33 个命名空间、152 个业务方法，其中 134 个普通方法、18 个流方法**。下表每一项拼成 `命名空间/方法` 即为完整名称，例如 `pluginManager/listPlugins`。标有“流”的方法由 `/api/remote.mux` 承载。网关保留的 `$events`、`$events/result`、连接握手、静态资源和 AVL 自有路由另计。这是注册清单，具体调用还受身份、会话和权限约束。

| 命名空间 | 数量 | 方法 |
| --- | ---: | --- |
| `account` | 12 | `cancelSignIn`、`getBalance`、`getNotificationContent`、`getNotifications`、`getProfile`、`getState`、`hasRunningAccountTasks`、`reportNotificationEvent`、`signOut`、`startSignIn`、`watch`（流）、`watchExpiry`（流） |
| `agentPresets` | 3 | `list`、`read`、`select` |
| `agentTeams` | 1 | `setEnabled` |
| `commands` | 2 | `execute`、`list` |
| `credentials` | 3 | `describe`、`set`、`unset` |
| `directoryPicker` | 3 | `createDirectory`、`list`、`pick` |
| `dynamicCordisRunner` | 12 | `getClientCode`、`inventory`、`invoke`、`reportClientGuardFailure`、`reportRenderFailure`、`resolveInspectQuery`、`resolveRequestRun`、`runHostHalf`、`settleUserRun`、`stopFromPanel`、`syncInspectManifest`、`undefineFromPanel` |
| `fileReferences` | 1 | `list` |
| `fileUploads` | 1 | `upload` |
| `goals` | 7 | `clear`、`complete`、`create`、`edit`、`get`、`pause`、`resume` |
| `job` | 3 | `follow`（流）、`kill`、`list`（流） |
| `llm` | 3 | `discoverModels`、`listConfigurableProviders`、`listProviders` |
| `mcpManager` | 3 | `probe`、`restart`、`watch`（流） |
| `messageFeedback` | 3 | `delete`、`list`、`put` |
| `officeKit` | 2 | `generation`、`render` |
| `permissionPresets` | 1 | `catalog` |
| `pluginInventory` | 1 | `list` |
| `pluginManager` | 15 | `cancelInstall`、`inspect`、`installBundle`、`listBundles`、`listPlugins`、`listVersionExemptions`、`listVersions`、`readBundleDetail`、`registries`、`removeBundle`、`setBundleEnabled`、`setPluginEnabled`、`setVersionExemption`、`updateBundle`、`waitForInstall` |
| `pluginRegistryProbe` | 1 | `fastest` |
| `remoteAccess` | 1 | `follow`（流） |
| `schedule` | 9 | `catalog`、`create`、`deleteInactive`、`deliveryLimits`、`edit`、`history`、`list`、`run`、`view` |
| `session` | 25 | `attachment`、`canOpenWorkspacePath`、`cancel`、`control`（流）、`create`、`events`、`follow`（流）、`fork`、`initializeDefaultModel`、`list`、`modelCatalog`、`observeEvent`（流）、`observeProjections`（流）、`observeState`（流）、`openWorkspacePath`、`page`、`projections`、`prompt`、`rename`、`search`、`selectModel`、`state`、`updateQueue`、`wait`、`workspacePathApplications` |
| `sessionFeedback` | 1 | `record` |
| `sessionReferenceResolver` | 1 | `candidates` |
| `settings` | 5 | `describe`、`mutate`、`openSettingsDocument`、`replace`、`update` |
| `skills` | 1 | `list` |
| `subagents` | 2 | `interruptByUser`、`prompt` |
| `terminal` | 9 | `attach`（流）、`close`、`create`、`environment`、`list`、`rename`、`retain`（流）、`shells`、`watch`（流） |
| `toolResults` | 1 | `watch`（流） |
| `userQuestions` | 2 | `answer`、`attachWait`（流） |
| `web` | 1 | `listProviders` |
| `workspace` | 11 | `archiveSession`、`create`、`delete`、`follow`（流）、`initializeDefault`、`insertBefore`、`insertSessionBefore`、`pinSession`、`rename`、`unarchiveSession`、`unpinSession` |
| `workspaceFiles` | 6 | `changes`（流）、`list`、`read`、`readBytes`、`search`、`stat` |

## 自建服务需要实现多少

**接主模型。** 手动指定模型 ID 时，至少实现 `POST /v1/chat/completions`。收取 `model`、`messages`、`tools` 与 `stream: true`；普通文字通过 SSE 的 `choices[].delta.content` 返回，工具调用通过结构化 `delta.tool_calls` 返回，携带调用索引、ID、函数名及 JSON 参数字符串。工具调用完成时返回 `finish_reason: "tool_calls"`，以 `data: [DONE]` 结束流。Host 执行工具，下一轮用同一 HTTP 接口发回助理的工具调用记录和带有匹配 `tool_call_id` 的 `role: "tool"` 消息。要支持模型发现，再实现 `GET /v1/models`，返回包含模型 ID 的 `data` 数组。桌面帧另经 WSS 发给 C。[项目主模型集成测试](../tests/test_workspaces.py) · [vLLM 服务接口](https://docs.vllm.ai/en/stable/serving/online_serving/openai_compatible_server/) · [vLLM 的模型列表路由](https://github.com/vllm-project/vllm/blob/main/docs/usage/security.md)

**用 vLLM 部署。** 两个 HTTP 端点已有实现。自动工具调用还取决于实际模型、chat template、vLLM 版本及匹配的 tool-call parser。按对应版本的文档配置自动工具选择（如 `--enable-auto-tool-choice` 和 `--tool-call-parser`）。将 `AVL_MAIN_MODEL` 设为 vLLM 提供的模型 ID。验收时依次验证普通流式回答、一次工具调用和工具结果返回后的最终回答。[vLLM 工具调用配置](https://docs.vllm.ai/en/stable/features/tool_calling/) · [环境变量模板](../.env.example)

**兼容整个 DSH 网页。** 可以直接保留 DSH Host 提供上表全部业务接口，自建服务只对接模型请求。如果还要替换 Host，需按锁定版本的 Typert 描述符实现参数、结果和错误格式，支持 `/api/<命名空间>/<方法>` 的请求信封与 WebSocket 流的打开、取消、事件和结束语义，还要实现 owner 身份、权限、会话持久化、插件清单和网页资源加载等行为。建议先验证登录、列工作区、创建会话、选择模型、发消息、收增量事件，再逐个与原 Host 对照其他命名空间。完整桌面面板还依赖 AVL 自有路由。可在已安装依赖中查看 Gateway 的 `src/index.ts`、`src/stream-protocol.ts`，以及各服务导出的 Typert 元数据。

**实测范围。** 用本地模拟推理服务驱动真实 DSH 聊天。模拟模型请求只读工具 `desktop_service_status`，Host 执行并将结果送回模型；这次模型侧记录到的请求路径全部为 `/v1/chat/completions`。vLLM 的端点和参数依据官方文档核对，本次未启动 GPU 推理服务。
