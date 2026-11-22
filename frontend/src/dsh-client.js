window.__ModuleLoader__.load({
  id: "avl-computer-use",
  factory(require) {
    const React = require("react");
    const id = "avl-computer-use/desktop";

    function HealthNotice({ t }) {
      const [health, setHealth] = React.useState(null);
      React.useEffect(() => {
        const lifetime = new AbortController();
        let timer;
        async function refresh() {
          try {
            const response = await fetch("/avl-desktop/health", {
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]),
              cache: "no-store",
            });
            if (response.status === 401 || response.status === 403) {
              setHealth(null);
            } else {
              if (!response.ok) throw new Error("Health status unavailable");
              setHealth(await response.json());
            }
          } catch {
            if (!lifetime.signal.aborted) setHealth({ state: "status_failed" });
          } finally {
            if (!lifetime.signal.aborted) timer = setTimeout(refresh, 2500);
          }
        }
        void refresh();
        return () => {
          lifetime.abort();
          clearTimeout(timer);
        };
      }, []);

      if (!health) return null;
      const summary = ["healthy", "disabled"].includes(health.state) ? null : t(health.state);
      const workspace = ["mount_unavailable", "workspace_unavailable"].includes(health.workspace)
        ? t(health.workspace) : null;
      if (!summary && !workspace) return null;
      const affected = Object.entries(health.components ?? {})
        .filter(([, state]) => state !== "healthy" && state !== "waiting_for_x11")
        .map(([component]) => t(component));
      return React.createElement("aside", {
        "data-avl-health": health.state, role: "status", "aria-live": "polite",
        style: {
          position: "fixed", zIndex: 30, bottom: "1rem", right: "1rem",
          maxWidth: "min(26rem, calc(100vw - 2rem))", border: "1px solid #d9a944",
          background: "#fff5dc", color: "#402b11", borderRadius: ".65rem",
          padding: ".65rem .85rem", fontSize: ".875rem", pointerEvents: "none",
        },
      },
      summary && React.createElement("div", null, summary),
      affected.length > 0 && React.createElement("div", null, affected.join(" · ")),
      health.repairing && React.createElement("div", null,
        `${t("attempt")} ${t(health.repairing)} (${health.attempt}/3)`),
      health.lastError && React.createElement("div", null, `${t("lastError")} ${t(health.lastError)}`),
      workspace && React.createElement("div", null, workspace));
    }

    return {
      inject: ["locale", "slots", "sidebarRightTabs"],
      apply(ctx) {
        const locale = "avlDesktop";
        ctx.effect(() => ctx.locale.register(locale, {
          zh: {
            title: "远程桌面", description: "查看 Agent 操作或接管桌面",
            checking: "正在检查桌面服务", degraded: "桌面服务异常，正在复查",
            recovering: "正在恢复桌面服务", failed: "桌面服务恢复失败，请检查 Host 与容器日志",
            ssh_unreachable: "桌面运维 SSH 无法访问，等待重连",
            probe_failed: "无法检查桌面服务，请查看 Host 日志",
            status_failed: "无法读取桌面恢复状态",
            mount_unavailable: "固定 SSHFS 工作区不可用，请检查挂载",
            workspace_unavailable: "固定工作目录不可用，请检查远端路径与 DSH 日志",
            workspace_offline: "工作区 SSH helper 未连接。桌面探测和恢复已暂停。请检查 SSH 与挂载，必要时重启 DSH Web。",
            attempt: "正在尝试", lastError: "上次恢复命令失败",
            x11: "X11 / VNC", xfce: "XFCE 会话", novnc: "noVNC", backend: "桌面后端",
          },
          en: {
            title: "Remote desktop", description: "Watch the agent or take control",
            checking: "Checking desktop services", degraded: "Rechecking a desktop service failure",
            recovering: "Recovering desktop services", failed: "Desktop recovery failed. Check the host and container logs.",
            ssh_unreachable: "Desktop operations SSH is unreachable. Waiting to reconnect.",
            probe_failed: "Unable to check desktop services. Check the host logs.",
            status_failed: "Unable to read the desktop recovery status",
            mount_unavailable: "Fixed SSHFS workspace unavailable. Check the mount.",
            workspace_unavailable: "Fixed workspace directory unavailable. Check its remote path and the DSH logs.",
            workspace_offline: "Workspace SSH helper offline. Desktop checks and repairs are paused. Check SSH and the mount, then restart DSH Web if needed.",
            attempt: "Recovering", lastError: "Last recovery command failed",
            x11: "X11 / VNC", xfce: "XFCE session", novnc: "noVNC", backend: "Desktop backend",
          },
        }));
        const t = ctx.locale.bind(locale);
        const title = () => t("title");
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind: "avl-desktop", title,
          guide: [{ id, order: 30, title, description: () => t("description") }],
        }));
        ctx.slots.inject("shell.overlay", () => ctx.slots.register(
          { name: "shell.overlay", id: "avl-desktop-health", locale },
          ({ t }) => React.createElement(HealthNotice, { t }),
        ));
        ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
          { name: "sidebar.right.pane.tab", key: id },
          () => React.createElement("iframe", {
            title: title(),
            src: "/avl-desktop/",
            style: { display: "block", width: "100%", height: "100%", border: 0 },
          }),
        ));
      },
    };
  },
});
