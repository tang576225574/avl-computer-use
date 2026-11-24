window.__ModuleLoader__.load({
  id: "avl-computer-use",
  factory(require) {
    const R = require("react");
    const element = R.createElement;
    const tabId = "avl-computer-use.screen";
    function Warning({t}) {
      const [alert, setAlert] = R.useState(null);
      R.useEffect(() => {
        const scope = new AbortController();
        let next;
        async function read() {
          try {
            const response = await fetch("/avl/health", {
              cache:"no-store", signal:AbortSignal.any([scope.signal, AbortSignal.timeout(3500)])
            });
            if (response.status === 403 || response.status === 401) { setAlert(null); return; }
            if (!response.ok) throw new Error("status");
            const health = await response.json();
            const affected = Object.entries(health.components ?? {})
              .filter(([,component]) => ["degraded","recovering","failed"].includes(component.state))
              .map(([name,component]) => name + (component.attempts > 0 ? " (" + component.attempts + "/3)" : ""));
            setAlert(["failed","recovering","degraded"].includes(health.state) ? [health.state, affected.join(", ")] : null);
          } catch {
            if (!scope.signal.aborted) setAlert(["unknown",""]);
          } finally {
            if (!scope.signal.aborted) next = setTimeout(read, 4000);
          }
        }
        void read();
        return () => {clearTimeout(next);scope.abort();};
      }, []);
      if (!alert) return null;
      return element("aside", {
        role:"status","aria-live":"polite",
        style:{position:"fixed",bottom:"1rem",right:"1rem",zIndex:40,maxWidth:"min(30rem,calc(100vw - 2rem))",
          background:"#fff4d9",border:"1px solid #d9ac58",color:"#523b17",borderRadius:8,padding:"9px 13px",
          fontSize:13,pointerEvents:"none"}
      }, t(alert[0]), alert[1] ? " · "+alert[1] : "");
    }
    function DesktopPane({useTabInfo,t}) {
      const visible = useTabInfo().tab.visible;
      return element("iframe", {
        "data-avl-visible":String(visible),
        src:"/avl/", title:t("title"),allow:"fullscreen",allowFullScreen:true,
        style:{display:"block",border:0,width:"100%",height:"100%",minHeight:0}
      });
    }
    return {
      inject:["sidebarRightTabs","slots","locale"],
      apply(ctx) {
        const namespace = "avlConsole";
        ctx.effect(() => ctx.locale.register(namespace,{
          zh:{title:"桌面控制台",guide:"观看或接管桌面，查看视频链路",failed:"桌面服务恢复失败",degraded:"桌面服务异常",recovering:"正在恢复桌面服务",unknown:"暂时无法获取桌面服务状态"},
          en:{title:"Desktop console",guide:"Watch or control the desktop and inspect video metrics",failed:"Desktop recovery failed",degraded:"Desktop service degraded",recovering:"Desktop recovery in progress",unknown:"Desktop health unavailable"}
        }));
        const t = ctx.locale.bind(namespace);
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id:tabId,kind:"avl-screen",keepMounted:true,title:()=>t("title"),
          guide:[{id:tabId,order:30,title:()=>t("title"),description:()=>t("guide")}]
        }));
        ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
          {name:"sidebar.right.pane.tab",key:tabId,locale:namespace}, DesktopPane));
        ctx.slots.inject("shell.overlay", () => ctx.slots.register(
          {name:"shell.overlay",id:"avl-health",locale:namespace}, Warning));
      }
    };
  }
});
