# 桌面镜像和启动

`Dockerfile` 的默认基础镜像是 `builder_20260611.sh` 生成的最终 accetto 镜像。也可用 `--build-arg DESKTOP_IMAGE=仓库名:标签` 选择含相同 TigerVNC、XFCE、noVNC 和 OpenSSH 的镜像。构建在独立 Node 阶段完成，Node 版本为 24.14.1。

```sh
docker build -t avl-desktop:v2 .
# 在宿主机通过部署系统注入本地运维密码、本桌面令牌和 C 的模型地址。
docker run --name avl -p 127.0.0.1:3080:3080 \
  -e AVL_SUDO_PASSWORD -e AVL_MODEL_TOKEN -e AVL_MODEL_WS \
  -e DSH_PUBLIC_URL=http://127.0.0.1:3080 \
  -v avl-ssh-hostkeys:/var/lib/avl-sshd \
  avl-desktop:v2
```

`/var/lib/avl-sshd` 保存本地 SSH 服务的主机密钥。另将工作目录与桌面用户的 DSH 数据目录挂载到持久卷以保留文件和对话。桌面用户名由基础镜像的 `HEADLESS_USER_NAME` 决定。启动日志中的 DSH owner 链接仅交给操作员。派生容器默认启用桌面管理，本地开发默认关闭。

上述命令在宿主机回环地址提供服务，浏览器从 `http://127.0.0.1:3080` 登录。若由反向代理发布到公网，将 `DSH_PUBLIC_URL` 改为访问者实际打开的 HTTPS 根地址，例如 `https://desk.example.org`，带自定义端口时也填写端口。启动器按该地址设置 DSH 对外 URL 和受信任的 Host。TLS 入口应保留原始 Host 和 Origin，转发 HTTP 与 WebSocket Upgrade。Host 通过单独的出站连接访问 C，模型服务不需要回连容器。容器内 `DSH_BIND` 决定实际监听地址，容器外的公开域名填在 `DSH_PUBLIC_URL`。

浏览器需要 HTTPS 直连容器时，也可以让 DSH 终止 TLS。将证书和私钥以只读方式挂载到容器，在镜像名后传入 DSH 原生参数，例如下列命令。证书须覆盖公开域名，且 DSH 进程所属的桌面用户需能读取挂载文件。浏览器验证 DSH 证书。

```bash
docker run --name avl-tls -p 3443:3080 \
  -e AVL_SUDO_PASSWORD -e AVL_MODEL_TOKEN -e AVL_MODEL_WS \
  -e DSH_PUBLIC_URL=https://desktop.example.org:3443 \
  -v /srv/avl/tls:/run/avl-tls:ro \
  -v avl-ssh-hostkeys:/var/lib/avl-sshd \
  avl-desktop:v2 --tls-cert /run/avl-tls/chain.pem --tls-key /run/avl-tls/key.pem
```

A 上另设 `AVL_MODEL_WS=wss://vision.example.org:8765/avl/model`。A 验证 C 的 TLS 证书，C 的监听、证书和令牌列表由模型管理员配置。镜像本身不需要安装 vLLM 或 GPU 驱动。

## 生命周期

PID 1 为 `tini`，其子进程进行一次性初始化、切换至桌面用户，再通过 `exec` 启动 DSH。DSH 退出时容器携带相应状态退出。部署方可根据退出状态选用 Docker 重启策略。DSH 默认使用容器的具体接口地址及端口 3080，可通过 `DSH_BIND` 和 `DSH_PORT` 覆盖。仅发布需要访问的端口。

插件每 5 秒探测显示服务、会话总线、XFCE 会话、窗口管理器、面板、终端、noVNC 与 SSH 服务。已有图形进程按桌面 UID 和 DISPLAY 识别。X11 除进程身份外会验证 VNC 横幅和 X11 请求，D-Bus 验证实际方法响应，noVNC 验证页面可达，sshd 验证已登记的监听进程和 SSH 横幅。首次启动桌面也会经过依赖检查，请等待面板报告就绪。异常连续出现两次后，每轮修复一个组件，连续失败最多修复三次。修复耗尽后查看 DSH 告警和容器日志，管理员恢复组件后状态会自动回到健康。采集按订阅需求探测。

VNC 与 noVNC 仅监听容器回环地址，维护客户端可通过已有的受控入口查看。独立 VNC 通道设置为只读。可选 `AVL_NOVNC_PASSWORD` 为独立的 6–8 个可打印 ASCII 字符，符合 VNCAuth 的长度限制；默认生成随机值。正常接管使用 DSH 的桌面标签页。

## 固定提权入口

运行时 `AVL_SUDO_PASSWORD` 用于本地不可登录的 `avl-ops` 账号。远程桌面用户可以启动无参数、由 root 拥有的运维入口。入口以 avl-ops 身份从受保护文件读取当前密码，交给 `sudo -k -S` 执行固定的 sshd 恢复操作。图形程序及普通工具以桌面用户权限运行。镜像移除基底的通用 sudoers 条目与旧凭据文件，启动时随机轮换桌面用户的旧密码，并创建独立 SSH 主机密钥。SSH 保留公钥登录，`AVL_SSHD_PORT` 默认为 22。启动容器时所需公钥通过该桌面用户的 authorized_keys 配置。

sudo 文件由 avl-ops 拥有，权限 0400，位于 root 拥有的运行目录。模型令牌通过一次性文件描述符交给 DSH。既有镜像层和构建历史可能含旧镜像密码，轮换会使旧桌面密码失效。Docker 宿主机管理员仍可查看其部署时注入的容器环境，请在可信主机上管理。

DSH、Agent 的普通工具与 XFCE 共享桌面用户的 UID。这个 UID 能修改自己的文件、向自己的进程发信号和访问本地 X11，所以同一容器适合单一信任域。人工接管互斥覆盖插件输入接口。sudo 凭据另由 avl-ops UID 持有，模型接入令牌必须使用独立值。

## 宿主机验收

```sh
python3 container/test-lifecycle.py avl-desktop:v2
```

脚本只对新建的随机命名测试容器执行故障注入。它检查 tini 的直接子进程、凭据隔离、Xvnc 和 sshd 重建，以及正常停止和强制终止 DSH 后的容器退出码。
