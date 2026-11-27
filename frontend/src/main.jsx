import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useDesktop } from "./connection.js";
import { desktopControls, pointOnScreen, keyAction } from "./viewer.js";
import "./style.css";

const serviceNames = { dbus:"桌面会话总线", x11:"X11 / VNC", xfce:"XFCE 会话", wm:"窗口管理器", panel:"XFCE 面板", terminal:"终端", novnc:"noVNC", sshd:"SSH 服务", capture:"屏幕采集" };
const serviceStates = { healthy:"正常", checking:"检查中", degraded:"异常", waiting:"等待依赖", idle:"空闲", recovering:"恢复中", failed:"失败", disabled:"未启用" };
const modes = {full:"全帧模型", simulator:"Omni 模拟器", benchmark:"基准接收器"};
const formatter = n => Number.isFinite(n) ? n.toLocaleString("zh-CN", {maximumFractionDigits:1}) : "—";
const unit = (value, suffix) => Number.isFinite(value) ? `${formatter(value)} ${suffix}` : "—";
function Pill({state, children}) { return <span className={`pill ${state}`}><i/>{children}</span>; }
function Metrics({ status }) {
  const m = status?.metrics ?? {};
  const active = Boolean(status?.subscribed);
  const sub = status ? (active ? "已订阅" : "未订阅") : "等待状态";
  const value = key => active ? m[key] : null;
  const cells = [
    ["模型接收", value("rxFps"), "fps"], ["单向延迟 P95", value("rxP95"), "ms"],
    ["模型处理",value("processedFps"),"fps"], ["桌面采集", m.captureFps, "fps"]
  ];
  return <section className="metrics" aria-labelledby="metrics-title">
    <header className="section-heading"><h2 id="metrics-title">视频链路</h2><Pill state={active ? "good" : "quiet"}>{sub}</Pill></header>
    <dl className="metrics-grid">{cells.map(([label, val, suffix]) => <div key={label}><dt>{label}</dt>
      <dd>{formatter(val)}{Number.isFinite(val) && <small>{suffix}</small>}</dd></div>)}</dl>
    <details><summary>链路详情</summary>
      <dl className="rows">{[
        ["模型类型", modes[status?.modelMode] ?? "未连接"],
        ["单向延迟 P50",unit(value("rxP50"),"ms")], ["时钟误差估计",unit(value("clockErrorMs"),"ms")],
        ["到视觉状态 P95（估计）",unit(value("processedP95"),"ms")], ["收帧确认往返 P95",unit(value("ackP95"),"ms")],
        ["视觉状态确认往返 P95",unit(value("visualAckP95"),"ms")], ["模型端处理 P95",unit(value("processingP95"),"ms")],
        ["模型已收帧",formatter(value("received"))], ["模型已处理帧",formatter(value("processed"))],
        ["接收序号缺口",formatter(value("sequenceGaps"))], ["模型抽样帧",formatter(value("sampled"))], ["模型主动丢帧",formatter(value("dropped"))],
        ["已发模型数据",unit(Number.isFinite(m.modelBytes) && active ? m.modelBytes/1048576 : null,"MiB")]
      ].map(([label,v]) => <div key={label}><dt>{label}</dt><dd>{v}</dd></div>)}</dl>
      {active && !Number.isFinite(m.rxP95) && <p>单向延迟待时钟校准，可参考收帧确认往返耗时。</p>}
    </details>
  </section>;
}
function Services({health}) {
  const components = Object.entries(health?.components ?? {});
  return <details className="services"><summary><span>桌面服务</span><span className="summary-tail">{serviceStates[health?.state] ?? "等待状态"}</span></summary>
    {components.length > 0 ? <dl className="rows">{components.map(([key, info]) => <div key={key}>
      <dt>{serviceNames[key] ?? key}</dt><dd title={info.detail ?? ""}>{serviceStates[info.state] ?? "未知"}{info.attempts > 0 ? ` · ${info.attempts}/3` : ""}</dd></div>)}</dl>
      : <p>{health?.state === "disabled" ? "当前环境未启用进程管理。" : "等待服务状态。"}</p>}
  </details>;
}

function App() {
  const canvas = useRef(null), stage = useRef(null);
  const desktop = useDesktop(canvas);
  const { state, status, display, fresh, send, frame, notice, setNotice } = desktop;
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const connected = state === "connected";
  const controls = desktopControls(connected ? status : null, fresh);
  const { manual, canResume, take } = controls;
  const otherOwner = status?.control === "human" && !status.owner;
  const locked = status?.control === "agent" && Boolean(status.holder);
  const interrupting = status?.control === "interrupting";
  const canAct = controls.canAct && !pending;
  const label = {connected:"已连接", connecting:"连接中", reconnecting:"重新连接中", hidden:"已暂停观看"}[state];
  const controlLabel = {
    agent: locked ? "桌面已锁定 · 仅可观看" : "桌面空闲",
    interrupting: "正在等待当前操作结束",
    human: otherOwner ? "由其他窗口控制" : "由你控制",
    paused: "桌面控制已暂停"
  }[status?.control] ?? "等待控制状态";

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (manual) canvas.current?.focus();
    else setDraft("");
  }, [manual]);

  async function control(command) {
    if (pending || !command) return;
    setPending(true);
    try { await send(command); } finally { setPending(false); }
  }
  const act = action => send({type:"act", action});
  function pointer(event) {
    return pointOnScreen(canvas.current.getBoundingClientRect(), frame.current, event.clientX, event.clientY);
  }
  function click(event) {
    if (!canAct) return;
    canvas.current.focus();
    const position = pointer(event);
    const button = ["left", "middle", "right"][event.button];
    if (position && button) {
      event.preventDefault(); void act({kind:"click", ...position, button});
    }
  }
  function onKey(event) {
    if (!canAct || event.key === "Tab" && event.shiftKey) return;
    const action = keyAction(event);
    if (action) { event.preventDefault(); void act(action); }
  }
  // React installs passive wheel listeners; only suppress local scrolling over a controlled screen.
  const wheel = useRef(null);
  wheel.current = event => {
    if (!canAct || !event.deltaY) return;
    const position = pointer(event);
    if (!position) return;
    event.preventDefault();
    void act({kind:"scroll", ...position, dy:Math.sign(event.deltaY)});
  };
  useEffect(() => {
    const screen = canvas.current;
    const handler = e => wheel.current(e);
    screen.addEventListener("wheel", handler, {passive:false});
    return () => screen.removeEventListener("wheel", handler);
  }, []);
  async function enlarge() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.current.requestFullscreen();
    } catch { setNotice("当前浏览器不允许全屏显示。"); }
  }
  const waiting = connected ? (display ? "正在等待新画面" : "正在等待桌面第一帧") : label;
  return <main>
    <header className="mast"><h1>桌面控制台</h1><Pill state={connected ? "good" : "waiting"}>{label}</Pill></header>
    <section ref={stage} className={`console${interrupting ? " draining" : locked ? " locked" : ""}`} aria-label="实时桌面">
      <div className="screen-bar"><span>实时桌面</span><span>{display ? `${display.width} × ${display.height}` : "—"}</span></div>
      <div className="screen">
        <canvas ref={canvas} aria-label="远程屏幕。接管后可点击并输入，按 Shift 加 Tab 移出画面" tabIndex={canAct ? 0 : -1}
          onPointerDown={click} onContextMenu={e => e.preventDefault()} onKeyDown={onKey} />
        {(!fresh || !display) && <div className="screen-state"><span className="waiting-indicator"/>{status?.captureError || waiting}</div>}
      </div>
      <div className="control-strip">
        <div className="control-status" role="status">
          <span className="control-mode"><span className={manual ? "dot human" : "dot"}/>{controlLabel}</span>
          {status && <div className="lock-details">
            {status.holder && <span>持有者 <bdi>{status.holder}</bdi></span>}
            {Number.isInteger(status.queueLength) && <span>排队 {status.queueLength}</span>}
            {status.controlError && <span className="lock-error">{status.controlError}</span>}
          </div>}
        </div>
        <div className="control-actions">
          {(!manual && !otherOwner) && <button key={take?.leaseId ?? ""} className={locked ? "primary interrupt" : "primary"} disabled={!take || pending} onClick={() => control(take)}>
            {interrupting ? "等待收尾…" : locked ? "中断并接管" : "接管"}
          </button>}
          {(manual || status?.control === "paused") && <button className="primary" disabled={!canResume || pending} onClick={() => control({type:"resume"})}>
            {manual ? "交还 Agent" : "恢复 Agent 控制"}
          </button>}
          <button type="button" className="ghost" disabled={interrupting || !document.fullscreenEnabled} onClick={enlarge}>{fullscreen ? "退出全屏" : "全屏"}</button>
        </div>
      </div>
      {manual && <form className="input-strip" onSubmit={async e => {
        e.preventDefault(); const text = draft;
        if (text && canAct && await act({kind:"type",text})) setDraft(current => current === text ? "" : current);
      }}><input maxLength={2000} disabled={!canAct} aria-label="输入到桌面" placeholder="输入或粘贴文本" value={draft} onChange={e => setDraft(e.target.value)}/>
        <button type="submit" className="ghost" disabled={!canAct || !draft}>发送</button></form>}
    </section>
    {notice && <p className="notice" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></p>}
    {status?.needsObservation && <p className="notice" role="status">Agent 操作桌面前需要先观察新画面。</p>}
    <Metrics status={status}/>
    <Services health={status?.services}/>
  </main>;
}

createRoot(document.getElementById("root")).render(<App/>);
