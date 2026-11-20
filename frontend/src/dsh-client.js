window.__ModuleLoader__.load({
  id: "avl-computer-use",
  factory(require) {
    const React = require("react");
    const id = "avl-computer-use/desktop";
    return {
      inject: ["locale", "slots", "sidebarRightTabs"],
      apply(ctx) {
        const locale = "avlDesktop";
        ctx.effect(() => ctx.locale.register(locale, {
          zh: { title: "远程桌面", description: "查看 Agent 操作或接管桌面" },
          en: { title: "Remote desktop", description: "Watch the agent or take control" },
        }));
        const t = ctx.locale.bind(locale);
        const title = () => t("title");
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind: "avl-desktop", title,
          guide: [{ id, order: 30, title, description: () => t("description") }],
        }));
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
