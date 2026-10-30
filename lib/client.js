/**
 * dsh-weixin 浏览器端插件。
 *
 * 职责：
 *   1. 在侧栏「插件」按钮下方插入一个微信图标（`sidebar.panellist`）
 *   2. 点击后在主面板打开微信通道设置页（`main` keyed slot）
 *   3. 把 `/weixin login|status|accounts|start|stop` 全部转成可视化操作
 *
 * 加载方式：由 `@deepseek-ai/dsh-client-modules` 从 `dsh.client` 声明 + `exports["./client"]`
 * 解析并注入为 `<script>`，执行时只注册 factory；模块体在首次 materialize 时运行。
 *
 * 硬约束（见 dsh-client-modules/README.md）：
 *   - 只能 `require()` 平台基线模块表内的 9 个包，其它一律抛错
 *   - 不能同步 require 另一个相对 `client*.js`
 *   - 因此本文件必须自包含，不引入任何相对模块
 */
window.__ModuleLoader__.load({
  id: "dsh-weixin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useRef = React.useRef;

    // =======================================================================
    // 常量
    // =======================================================================

    /** 侧栏面板 id，同时是 main keyed slot 的 key。 */
    var PANEL_ID = "weixin";
    /** 侧栏排序：插件按钮是 0，微信紧贴其后。 */
    var PANEL_ORDER = 1;
    /** 品牌绿。 */
    var WEIXIN_GREEN = "#07C160";
    /** 路由前缀（服务端注册于 /api/dsh-weixin/*）。 */
    var API_BASE = "/api/dsh-weixin";

    // =======================================================================
    // 微信官方图标
    // =======================================================================

    /**
     * 微信官方 logo：两枚重叠对话气泡（左大右小）+ 各两枚白色眼睛。
     *
     * 用 ellipse 而非 path 构造，保证在 16–24px 区间都不会因坐标误差走形。
     *
     * @param {object} props - 组件属性
     * @param {number} [props.size] - 边长（像素）
     * @param {boolean} [props.active] - 选中态（选中时整体稍微放大对比度）
     * @returns {object} React 元素
     */
    function WeixinIcon(props) {
      var size = props.size || 20;
      var active = Boolean(props.active);

      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
          focusable: "false",
        },
        // 大气泡（左下）
        h("ellipse", {
          cx: 9,
          cy: 9.2,
          rx: 7.2,
          ry: 6.2,
          fill: WEIXIN_GREEN,
          opacity: active ? 1 : 0.92,
        }),
        // 小气泡（右上），与大泡重叠
        h("ellipse", {
          cx: 16.4,
          cy: 15.1,
          rx: 5.6,
          ry: 4.9,
          fill: WEIXIN_GREEN,
          opacity: active ? 1 : 0.92,
        }),
        // 大气泡的两只眼睛
        h("circle", { cx: 6.4, cy: 7.3, r: 1.02, fill: "#FFFFFF" }),
        h("circle", { cx: 11.6, cy: 7.3, r: 1.02, fill: "#FFFFFF" }),
        // 小气泡的两只眼睛
        h("circle", { cx: 14.3, cy: 13.9, r: 0.82, fill: "#FFFFFF" }),
        h("circle", { cx: 18.5, cy: 13.9, r: 0.82, fill: "#FFFFFF" }),
      );
    }

    // =======================================================================
    // HTTP 客户端
    // =======================================================================

    /**
     * 调用服务端 JSON 端点。
     *
     * 同源请求自动携带会话 cookie，无需额外鉴权头。
     *
     * @param {string} path - `/api/dsh-weixin` 之后的路径
     * @param {object} [options] - 选项
     * @param {string} [options.method] - HTTP 方法
     * @param {object} [options.body] - JSON 请求体
     * @param {AbortSignal} [options.signal] - 取消信号
     * @returns {Promise<object>} 响应体
     */
    async function api(path, options) {
      var opts = options || {};
      var init = {
        method: opts.method || "GET",
        credentials: "same-origin",
        headers: {},
      };
      if (opts.signal) init.signal = opts.signal;
      if (opts.body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }

      var res = await fetch(API_BASE + "/" + path, init);
      var text = await res.text();
      var data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (err) {
        throw new Error("服务端返回了非 JSON 响应（HTTP " + res.status + "）");
      }
      if (!res.ok && !data.error && !data.message) {
        throw new Error("HTTP " + res.status);
      }
      return data;
    }

    // =======================================================================
    // 通用 UI 片段（用内联样式 + 主题 token，避免依赖未导出的组件）
    // =======================================================================

    var styles = {
      page: {
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        padding: "24px 28px 40px",
        maxWidth: "820px",
        overflowY: "auto",
        height: "100%",
        boxSizing: "border-box",
        color: "var(--dsw-alias-label-primary)",
      },
      header: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
      },
      title: {
        margin: 0,
        fontSize: "18px",
        fontWeight: 600,
        lineHeight: "26px",
      },
      intro: {
        margin: 0,
        fontSize: "13px",
        lineHeight: "20px",
        color: "var(--dsw-alias-label-tertiary)",
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "16px 18px",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: "12px",
        background: "var(--dsw-alias-bg-layer-1)",
      },
      cardTitle: {
        margin: 0,
        fontSize: "14px",
        fontWeight: 600,
        lineHeight: "22px",
      },
      row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
      },
      rowText: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        minWidth: 0,
      },
      label: {
        fontSize: "13px",
        lineHeight: "20px",
      },
      hint: {
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)",
      },
      field: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      },
      sectionTitle: {
        display: "flex",
        alignItems: "baseline",
        gap: "8px",
        marginTop: "4px",
        paddingTop: "14px",
        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
        fontSize: "13px",
        fontWeight: 600,
        lineHeight: "20px",
      },
      sectionHint: {
        fontSize: "12px",
        fontWeight: 400,
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)",
      },
      textarea: {
        resize: "vertical",
        minHeight: "120px",
        fontFamily: "inherit",
        lineHeight: "20px",
      },
      input: {
        width: "100%",
        boxSizing: "border-box",
        padding: "7px 10px",
        fontSize: "13px",
        lineHeight: "20px",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: "8px",
        outline: "none",
      },
      actions: {
        display: "flex",
        gap: "8px",
        flexWrap: "wrap",
      },
      button: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 14px",
        fontSize: "13px",
        lineHeight: "20px",
        fontFamily: "inherit",
        cursor: "pointer",
        borderRadius: "8px",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
      },
      buttonPrimary: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 14px",
        fontSize: "13px",
        lineHeight: "20px",
        fontFamily: "inherit",
        cursor: "pointer",
        borderRadius: "8px",
        border: "0.5px solid transparent",
        background: WEIXIN_GREEN,
        color: "#FFFFFF",
        fontWeight: 500,
      },
      buttonDanger: {
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 10px",
        fontSize: "12px",
        fontFamily: "inherit",
        cursor: "pointer",
        borderRadius: "7px",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "var(--dsw-alias-label-tertiary)",
      },
      dot: {
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        flexShrink: 0,
      },
      badge: {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 9px",
        fontSize: "12px",
        lineHeight: "18px",
        borderRadius: "999px",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        color: "var(--dsw-alias-label-secondary)",
      },
      qr: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "12px",
        padding: "18px",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: "12px",
        background: "var(--dsw-alias-bg-layer-1)",
      },
      qrImg: {
        width: "200px",
        height: "200px",
        objectFit: "contain",
        borderRadius: "8px",
        // 二维码必须有纯白底，否则深色主题下对比度不足扫不出来
        background: "#FFFFFF",
        padding: "8px",
        display: "block",
      },
      qrFallback: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        width: "200px",
        height: "200px",
        borderRadius: "8px",
        border: "0.5px dashed var(--dsw-alias-border-l2)",
      },
      mono: {
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: "12px",
      },
      error: {
        margin: 0,
        padding: "9px 12px",
        fontSize: "12.5px",
        lineHeight: "19px",
        borderRadius: "var(--dsw-radius-md, 8px)",
        color: "var(--dsw-alias-label-error)",
        // DSH 没有 error 背景 token，用 currentColor 混一层淡底，
        // 深浅主题自动跟随文字色，不会像写死 rgba 那样在浅色下失效。
        background: "color-mix(in srgb, currentColor 8%, transparent)",
      },
      empty: {
        margin: 0,
        fontSize: "13px",
        lineHeight: "20px",
        color: "var(--dsw-alias-label-tertiary)",
      },
    };

    /**
     * 一行「标签 + 说明 + 右侧控件」。
     *
     * @param {object} props - 组件属性
     * @returns {object} React 元素
     */
    function SettingRow(props) {
      return h(
        "div",
        { style: styles.row },
        h(
          "div",
          { style: styles.rowText },
          h("span", { style: styles.label }, props.label),
          props.hint ? h("span", { style: styles.hint }, props.hint) : null,
        ),
        props.children,
      );
    }

    /**
     * 自绘开关（不依赖 primitives 的 Switch，保持视觉一致且零风险）。
     *
     * @param {object} props - 组件属性
     * @returns {object} React 元素
     */
    function Toggle(props) {
      var checked = Boolean(props.checked);
      var disabled = Boolean(props.disabled);
      var onClick = useCallback(
        function () {
          if (disabled) return;
          props.onChange(!checked);
        },
        [checked, disabled, props.onChange],
      );

      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": checked,
          "aria-label": props.label || "",
          disabled: disabled,
          onClick: onClick,
          style: {
            position: "relative",
            width: "38px",
            height: "22px",
            flexShrink: 0,
            padding: 0,
            borderRadius: "999px",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.5 : 1,
            transition: "background 120ms ease",
            border: "0.5px solid transparent",
            // 开启态用品牌绿；关闭态用官方 interactive 底，与 DSH 自带 Switch 一致
            background: checked
              ? WEIXIN_GREEN
              : "var(--dsw-alias-interactive-bg-active)",
          },
        },
        h("span", {
          style: {
            position: "absolute",
            top: "2px",
            left: checked ? "18px" : "2px",
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            background: "var(--dsw-alias-switch-thumb, #FFFFFF)",
            transition: "left 120ms ease",
            boxShadow: "0 1px 2px rgba(0,0,0,0.18)",
          },
        }),
      );
    }

    /**
     * 分段选择器。
     *
     * @param {object} props - 组件属性
     * @returns {object} React 元素
     */
    function Segmented(props) {
      var value = props.value;
      var options = props.options || [];
      return h(
        "div",
        {
          style: {
            display: "inline-flex",
            padding: "3px",
            gap: "2px",
            borderRadius: "var(--dsw-radius-md, 8px)",
            // 与 DSH 自带分段控件一致的轨道底色
            background: "var(--dsw-alias-interactive-bg-hover)",
          },
        },
        options.map(function (opt) {
          var active = opt.value === value;
          return h(
            "button",
            {
              key: opt.value,
              type: "button",
              disabled: props.disabled,
              onClick: function () {
                if (props.disabled) return;
                props.onChange(opt.value);
              },
              style: {
                padding: "3px 12px",
                fontSize: "12.5px",
                lineHeight: "19px",
                fontFamily: "inherit",
                borderRadius: "var(--dsw-radius-sm, 6px)",
                border: "0",
                cursor: props.disabled ? "not-allowed" : "pointer",
                opacity: props.disabled ? 0.6 : 1,
                // 选中态用 layer-1（深色主题下是浅一档的灰），文字用 primary，
                // 保证深/浅主题都有对比度。切勿写死 #fff —— 深色主题会变成白底白字。
                background: active ? "var(--dsw-alias-bg-layer-1)" : "transparent",
                color: active
                  ? "var(--dsw-alias-label-primary)"
                  : "var(--dsw-alias-label-tertiary)",
                fontWeight: active ? 500 : 400,
                boxShadow: active ? "var(--dsw-elevation-soft)" : "none",
                transition: "background 120ms ease, color 120ms ease",
              },
            },
            opt.label,
          );
        }),
      );
    }

    /**
     * 文本输入。
     *
     * @param {object} props - 组件属性
     * @returns {object} React 元素
     */
    function TextInput(props) {
      return h("input", {
        type: props.type || "text",
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        onChange: function (e) {
          props.onChange(e.target.value);
        },
        style: Object.assign({}, styles.input, props.style || {}),
      });
    }

    // =======================================================================
    // 登录卡片
    // =======================================================================

    /**
     * 扫码登录流程。
     *
     * 状态机：idle → starting → waiting（wait/scaned/need_verifycode）→ done
     *
     * @param {object} props - 组件属性
     * @param {() => void} props.onLoggedIn - 登录成功回调
     * @returns {object} React 元素
     */
    function LoginCard(props) {
      var [phase, setPhase] = useState("idle");
      var [sessionKey, setSessionKey] = useState("");
      var [qrcodeUrl, setQrcodeUrl] = useState("");
      var [qrcodeImage, setQrcodeImage] = useState("");
      var [statusText, setStatusText] = useState("");
      var [needsCode, setNeedsCode] = useState(false);
      var [code, setCode] = useState("");
      var [error, setError] = useState("");
      var [result, setResult] = useState(null);
      var pollRef = useRef(null);

      /** 停止轮询。 */
      var stopPolling = useCallback(function () {
        if (pollRef.current) {
          clearTimeout(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      useEffect(function () {
        return function () {
          stopPolling();
        };
      }, [stopPolling]);

      /**
       * 轮询登录进度，直到 done。
       *
       * @param {string} key - sessionKey
       */
      var poll = useCallback(
        function poll(key) {
          var tick = async function () {
            try {
              var data = await api(
                "login/status?sessionKey=" + encodeURIComponent(key),
              );
              if (data.done) {
                stopPolling();
                setResult(data.result || {});
                if (data.result && data.result.ok) {
                  setPhase("done");
                  if (props.onLoggedIn) props.onLoggedIn();
                } else {
                  setPhase("error");
                  setError((data.result && data.result.message) || "登录未完成");
                }
                return;
              }
              setQrcodeUrl(data.qrcodeUrl || "");
              setQrcodeImage(data.qrcodeImage || "");
              setNeedsCode(Boolean(data.needsVerifyCode));
              setStatusText(
                data.status === "scaned"
                  ? "已扫描，请在手机上确认"
                  : data.status === "need_verifycode"
                    ? "需要输入手机上显示的验证码"
                    : "等待扫描…",
              );
              pollRef.current = setTimeout(tick, 1500);
            } catch (err) {
              stopPolling();
              setPhase("error");
              setError(String(err && err.message ? err.message : err));
            }
          };
          tick();
        },
        [props.onLoggedIn, stopPolling],
      );

      /** 发起登录。 */
      var start = useCallback(async function () {
        setError("");
        setResult(null);
        setCode("");
        setNeedsCode(false);
        setPhase("starting");
        setStatusText("");
        try {
          var data = await api("login/start", { method: "POST", body: {} });
          if (!data.ok || !data.qrcodeUrl) {
            setPhase("error");
            setError(data.error || "获取二维码失败");
            return;
          }
          setSessionKey(data.sessionKey);
          setQrcodeUrl(data.qrcodeUrl);
          setQrcodeImage(data.qrcodeImage || "");
          setPhase("waiting");
          setStatusText("等待扫描…");
          poll(data.sessionKey);
        } catch (err) {
          setPhase("error");
          setError(String(err && err.message ? err.message : err));
        }
      }, [poll]);

      /** 提交验证码。 */
      var submit = useCallback(
        async function () {
          if (!code.trim()) return;
          try {
            await api("login/verify", {
              method: "POST",
              body: { sessionKey: sessionKey, code: code.trim() },
            });
            setCode("");
            setNeedsCode(false);
            setStatusText("正在验证…");
          } catch (err) {
            setError(String(err && err.message ? err.message : err));
          }
        },
        [code, sessionKey],
      );

      /** 取消登录。 */
      var cancel = useCallback(async function () {
        stopPolling();
        try {
          await api("login/cancel", {
            method: "POST",
            body: { sessionKey: sessionKey },
          });
        } catch (err) {
          /* 取消失败不阻塞 UI */
        }
        setPhase("idle");
        setQrcodeUrl("");
        setQrcodeImage("");
        setStatusText("");
        setNeedsCode(false);
      }, [sessionKey, stopPolling]);

      // ---- 渲染 ----

      if (phase === "idle") {
        return h(
          "div",
          { style: styles.card },
          h(
            "div",
            { style: styles.row },
            h(
              "div",
              { style: styles.rowText },
              h("h3", { style: styles.cardTitle }, "连接微信"),
              h(
                "span",
                { style: styles.hint },
                "用手机微信扫码，把这台机器接入微信通道",
              ),
            ),
            h(
              "button",
              { type: "button", style: styles.buttonPrimary, onClick: start },
              "扫码登录",
            ),
          ),
          error ? h("p", { style: styles.error }, error) : null,
        );
      }

      if (phase === "starting") {
        return h(
          "div",
          { style: styles.card },
          h("span", { style: styles.hint }, "正在获取二维码…"),
        );
      }

      if (phase === "waiting") {
        return h(
          "div",
          { style: styles.qr },
          qrcodeImage
            ? h("img", {
                src: qrcodeImage,
                alt: "微信登录二维码",
                width: 200,
                height: 200,
                style: styles.qrImg,
              })
            : h(
                "div",
                { style: styles.qrFallback },
                h("span", { style: styles.hint }, "二维码渲染失败"),
                qrcodeUrl
                  ? h(
                      "a",
                      {
                        href: qrcodeUrl,
                        target: "_blank",
                        rel: "noreferrer noopener",
                        style: { color: WEIXIN_GREEN, fontSize: "12.5px" },
                      },
                      "点此打开登录链接",
                    )
                  : null,
              ),
          h(
            "span",
            { style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)" } },
            statusText,
          ),
          needsCode
            ? h(
                "div",
                {
                  style: {
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    width: "100%",
                    maxWidth: "280px",
                  },
                },
                h(TextInput, {
                  value: code,
                  onChange: setCode,
                  placeholder: "输入手机上显示的数字",
                }),
                h(
                  "button",
                  { type: "button", style: styles.buttonPrimary, onClick: submit },
                  "确认",
                ),
              )
            : null,
          // 兜底链接：二维码扫不出来时可以直接在手机微信里打开
          qrcodeUrl
            ? h(
                "a",
                {
                  href: qrcodeUrl,
                  target: "_blank",
                  rel: "noreferrer noopener",
                  style: {
                    fontSize: "12px",
                    color: "var(--dsw-alias-label-tertiary)",
                    textDecoration: "underline",
                  },
                },
                "扫不出来？在手机微信中打开链接",
              )
            : null,
          h(
            "div",
            { style: styles.actions },
            h(
              "button",
              { type: "button", style: styles.button, onClick: cancel },
              "取消",
            ),
          ),
          error ? h("p", { style: styles.error }, error) : null,
        );
      }

      if (phase === "done") {
        return h(
          "div",
          { style: styles.card },
          h(
            "div",
            { style: styles.row },
            h(
              "div",
              { style: styles.rowText },
              h("h3", { style: styles.cardTitle }, "已连接微信"),
              h(
                "span",
                { style: styles.hint },
                result && result.accountId
                  ? "账号 ID：" + result.accountId
                  : result && result.message
                    ? result.message
                    : "连接成功",
              ),
            ),
            h(
              "button",
              {
                type: "button",
                style: styles.button,
                onClick: function () {
                  setPhase("idle");
                },
              },
              "再连一个",
            ),
          ),
        );
      }

      return h(
        "div",
        { style: styles.card },
        h("h3", { style: styles.cardTitle }, "登录失败"),
        h("p", { style: styles.error }, error || "未知错误"),
        h(
          "div",
          { style: styles.actions },
          h(
            "button",
            {
              type: "button",
              style: styles.buttonPrimary,
              onClick: start,
            },
            "重新扫码",
          ),
        ),
      );
    }

    // =======================================================================
    // 主面板页
    // =======================================================================

    /**
     * 微信通道设置页。
     *
     * @returns {object} React 元素
     */
    function WeixinPanelPage() {
      var [state, setState] = useState(null);
      var [loading, setLoading] = useState(true);
      var [error, setError] = useState("");
      var [busy, setBusy] = useState("");

      /**
       * 拉取通道状态。
       *
       * @returns {Promise<void>}
       */
      var refresh = useCallback(async function () {
        try {
          var data = await api("state");
          setState(data);
          setError("");
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(
        function () {
          refresh();
          var timer = setInterval(refresh, 5000);
          return function () {
            clearInterval(timer);
          };
        },
        [refresh],
      );

      /**
       * 执行一次会改变状态的操作。
       *
       * @param {string} tag - 忙碌标记
       * @param {() => Promise<any>} fn - 操作
       * @returns {Promise<void>}
       */
      var run = useCallback(
        async function (tag, fn) {
          setBusy(tag);
          setError("");
          try {
            await fn();
            await refresh();
          } catch (err) {
            setError(String(err && err.message ? err.message : err));
          } finally {
            setBusy("");
          }
        },
        [refresh],
      );

      /** 删除账号。 */
      var removeAccount = useCallback(
        function (accountId) {
          return run("remove:" + accountId, function () {
            return api("accounts/remove", {
              method: "POST",
              body: { accountId: accountId },
            });
          });
        },
        [run],
      );

      // ---- 渲染 ----

      if (loading) {
        return h(
          "div",
          { style: styles.page },
          h("span", { style: styles.hint }, "加载中…"),
        );
      }

      var accounts = (state && state.accounts) || [];
      var settings = (state && state.settings) || {};
      var running = Boolean(state && state.running);

      return h(
        "div",
        { style: styles.page },

        // 标题
        h(
          "div",
          { style: styles.header },
          h(WeixinIcon, { size: 24 }),
          h("h1", { style: styles.title }, "微信通道"),
        ),
        h(
          "p",
          { style: styles.intro },
          "把这台 DSH 接入微信：扫码登录后，微信消息会进入这里的 Agent 会话，回复也会发回微信。",
        ),

        error ? h("p", { style: styles.error }, error) : null,

        // 运行状态
        h(
          "div",
          { style: styles.card },
          h(
            "div",
            { style: styles.row },
            h(
              "div",
              { style: styles.rowText },
              h("h3", { style: styles.cardTitle }, "通道状态"),
              h(
                "span",
                { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", {
                  style: Object.assign({}, styles.dot, {
                    background: running ? WEIXIN_GREEN : "var(--dsw-alias-label-tertiary)",
                  }),
                }),
                h(
                  "span",
                  { style: styles.hint },
                  running ? "轮询运行中" : "未启动",
                ),
              ),
            ),
            h(
              "div",
              { style: styles.actions },
              running
                ? h(
                    "button",
                    {
                      type: "button",
                      style: styles.button,
                      disabled: busy === "stop",
                      onClick: function () {
                        run("stop", function () {
                          return api("stop", { method: "POST", body: {} });
                        });
                      },
                    },
                    busy === "stop" ? "停止中…" : "停止",
                  )
                : h(
                    "button",
                    {
                      type: "button",
                      style: styles.buttonPrimary,
                      disabled: busy === "start" || accounts.length === 0,
                      onClick: function () {
                        run("start", function () {
                          return api("start", { method: "POST", body: {} });
                        });
                      },
                    },
                    busy === "start" ? "启动中…" : "启动",
                  ),
            ),
          ),
          accounts.length === 0
            ? h(
                "span",
                { style: styles.hint },
                "尚未登录账号，先扫码登录再启动通道。",
              )
            : null,
        ),

        // 登录
        h(LoginCard, { onLoggedIn: refresh }),

        // 账号列表
        h(
          "div",
          { style: styles.card },
          h("h3", { style: styles.cardTitle }, "已登录账号"),
          accounts.length === 0
            ? h("p", { style: styles.empty }, "还没有账号。")
            : accounts.map(function (acc) {
                var convKey = acc.accountId;
                return h(
                  "div",
                  { key: convKey, style: styles.row },
                  h(
                    "div",
                    { style: styles.rowText },
                    h(
                      "span",
                      { style: Object.assign({}, styles.label, styles.mono) },
                      acc.accountId,
                    ),
                    h(
                      "span",
                      { style: styles.hint },
                      [
                        acc.userId ? "用户 " + acc.userId : null,
                        acc.savedAt
                          ? "登录于 " + String(acc.savedAt).slice(0, 10)
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "无附加信息",
                    ),
                  ),
                  h(
                    "div",
                    { style: styles.actions },
                    h(
                      "span",
                      { style: styles.badge },
                      acc.configured ? "已配置" : "未配置",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: styles.buttonDanger,
                        disabled: busy === "remove:" + acc.accountId,
                        onClick: function () {
                          removeAccount(acc.accountId);
                        },
                      },
                      busy === "remove:" + acc.accountId ? "删除中…" : "删除",
                    ),
                  ),
                );
              }),
        ),

        // 配置（可写：点击即生效，落盘到插件自有 overlay）
        h(SettingsCard, {
          settings: settings,
          overridden: (state && state.overridden) || [],
          onSaved: refresh,
        }),
      );
    }

    // =======================================================================
    // 配置卡片（可写）
    // =======================================================================

    /**
     * 通道配置卡片。
     *
     * 交互约定：
     *   - 开关 / 分段选择器：一点即存（点完立刻生效，无需再按保存）
     *   - 数字与文本输入：停止输入 700ms 后自动保存，避免每敲一个字符打一次请求
     *   - 保存成功后由父组件 `refresh()` 回读真实生效值，保证界面与后端一致
     *
     * @param {object} props - 组件属性
     * @param {object} props.settings - 当前生效配置
     * @param {string[]} props.overridden - 已被 UI 覆盖的顶层键
     * @param {() => Promise<void>} props.onSaved - 保存成功后回调
     * @returns {object} React 元素
     */
    function SettingsCard(props) {
      var settings = props.settings || {};
      var overridden = props.overridden || [];

      // 草稿态：文本输入先改这里，稳定后再提交
      var [draft, setDraft] = useState({});
      var [saveState, setSaveState] = useState(""); // "" | saving | saved | error
      var [saveError, setSaveError] = useState("");
      var [needsRestart, setNeedsRestart] = useState([]);
      var timerRef = useRef(null);

      /** 卸载时清掉待提交的定时器。 */
      useEffect(function () {
        return function () {
          if (timerRef.current) clearTimeout(timerRef.current);
        };
      }, []);

      /**
       * 取生效值：草稿优先，回落到服务端值。
       *
       * @param {string} key - 字段名
       * @param {*} fallback - 服务端缺省值
       * @returns {*} 值
       */
      var val = useCallback(
        function (key, fallback) {
          if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key];
          var v = settings[key];
          return v === undefined || v === null ? fallback : v;
        },
        [draft, settings],
      );

      /**
       * 提交一批字段。
       *
       * @param {object} patch - 扁平补丁
       * @returns {Promise<void>}
       */
      var commit = useCallback(async function (patch) {
        setSaveState("saving");
        setSaveError("");
        try {
          var res = await api("settings", { method: "POST", body: patch });
          if (!res.ok) {
            setSaveState("error");
            setSaveError(res.error || "保存失败");
            return;
          }
          if (res.needsRestart && res.needsRestart.length > 0) {
            setNeedsRestart(res.needsRestart);
          }
          setSaveState("saved");
          // 清空草稿，让界面回到服务端真实值
          setDraft(function (prev) {
            var next = Object.assign({}, prev);
            Object.keys(patch).forEach(function (k) {
              delete next[k];
            });
            return next;
          });
          if (props.onSaved) await props.onSaved();
          setTimeout(function () {
            setSaveState(function (s) {
              return s === "saved" ? "" : s;
            });
          }, 1800);
        } catch (err) {
          setSaveState("error");
          setSaveError(String(err && err.message ? err.message : err));
        }
      }, [props.onSaved]);

      /**
       * 立即保存（开关/分段）。
       *
       * @param {string} key - 字段名
       * @param {*} value - 新值
       * @returns {void}
       */
      var saveNow = useCallback(
        function (key, value) {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          setDraft(function (prev) {
            return Object.assign({}, prev, { [key]: value });
          });
          var patch = {};
          patch[key] = value;
          commit(patch);
        },
        [commit],
      );

      /**
       * 延迟保存（文本/数字）。
       *
       * @param {string} key - 字段名
       * @param {*} value - 新值
       * @returns {void}
       */
      var saveLater = useCallback(
        function (key, value) {
          setDraft(function (prev) {
            return Object.assign({}, prev, { [key]: value });
          });
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(function () {
            timerRef.current = null;
            var patch = {};
            patch[key] = value;
            commit(patch);
          }, 700);
        },
        [commit],
      );

      /** 数字输入：只保留数字字符。 */
      var onNumber = useCallback(
        function (key) {
          return function (raw) {
            var cleaned = String(raw).replace(/[^\d]/g, "");
            saveLater(key, cleaned === "" ? 0 : Number(cleaned));
          };
        },
        [saveLater],
      );

      /** 状态提示文案。 */
      var statusNode = null;
      if (saveState === "saving") {
        statusNode = h("span", { style: styles.hint }, "保存中…");
      } else if (saveState === "saved") {
        statusNode = h(
          "span",
          { style: { fontSize: "12px", color: WEIXIN_GREEN } },
          "已保存",
        );
      } else if (saveState === "error") {
        statusNode = h(
          "span",
          { style: { fontSize: "12px", color: "var(--dsw-alias-label-error)" } },
          saveError || "保存失败",
        );
      }

      var streamMode = val("outboundMode", "final") === "stream";
      var isOverridden = function (key) {
        return overridden.indexOf(key) !== -1;
      };
      /** 「已自定义」小标记。 */
      var customTag = function (key) {
        return isOverridden(key)
          ? h(
              "span",
              {
                style: {
                  marginLeft: "6px",
                  padding: "0 6px",
                  fontSize: "11px",
                  lineHeight: "16px",
                  borderRadius: "999px",
                  color: WEIXIN_GREEN,
                  border: "0.5px solid " + WEIXIN_GREEN,
                },
              },
              "已自定义",
            )
          : null;
      };

      return h(
        "div",
        { style: styles.card },
        h(
          "div",
          { style: styles.row },
          h(
            "div",
            { style: styles.rowText },
            h("h3", { style: styles.cardTitle }, "通道配置"),
            h(
              "span",
              { style: styles.hint },
              "改动即时保存，无需编辑配置文件，也无需重启",
            ),
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "10px" } },
            statusNode,
            h(
              "button",
              {
                type: "button",
                style: styles.buttonDanger,
                onClick: async function () {
                  try {
                    var res = await api("settings/reset", {
                      method: "POST",
                      body: {},
                    });
                    setNeedsRestart(res.needsRestart ? ["全部设置"] : []);
                    setDraft({});
                    setSaveState("saved");
                    if (props.onSaved) await props.onSaved();
                  } catch (err) {
                    setSaveState("error");
                    setSaveError(String(err && err.message ? err.message : err));
                  }
                },
              },
              "恢复默认",
            ),
          ),
        ),

        // 出站模式
        h(
          SettingRow,
          {
            label: h("span", null, "出站模式", customTag("outbound")),
            hint: "整段：等回复完成一次性发出；流式：边生成边发（更像聊天）",
          },
          h(Segmented, {
            value: val("outboundMode", "final"),
            options: [
              { value: "final", label: "整段" },
              { value: "stream", label: "流式" },
            ],
            onChange: function (v) {
              saveNow("outboundMode", v);
            },
          }),
        ),

        // 流式专属参数
        streamMode
          ? h(
              SettingRow,
              {
                label: h("span", null, "流式合并阈值", customTag("outbound")),
                hint: "累积到多少字符才发一段，越大越省消息数",
              },
              h(
                "div",
                { style: { width: "110px" } },
                h(TextInput, {
                  value: String(val("minChars", 1600)),
                  onChange: onNumber("minChars"),
                  style: { textAlign: "right" },
                }),
              ),
            )
          : null,

        streamMode
          ? h(
              SettingRow,
              {
                label: h("span", null, "合并空闲窗口", customTag("outbound")),
                hint: "停止输出超过该毫秒数就立刻发出，不再等阈值",
              },
              h(
                "div",
                { style: { width: "110px" } },
                h(TextInput, {
                  value: String(val("idleMs", 3000)),
                  onChange: onNumber("idleMs"),
                  style: { textAlign: "right" },
                }),
              ),
            )
          : null,

        // 单条上限
        h(
          SettingRow,
          {
            label: h("span", null, "单条消息上限", customTag("outbound")),
            hint: "超出后自动分段（字符），微信侧过长消息易丢失",
          },
          h(
            "div",
            { style: { width: "110px" } },
            h(TextInput, {
              value: String(val("textChunkLimit", 4000)),
              onChange: onNumber("textChunkLimit"),
              style: { textAlign: "right" },
            }),
          ),
        ),

        // 会话模式
        h(
          SettingRow,
          {
            label: h("span", null, "会话模式", customTag("session")),
            hint: "单会话：同一用户始终接续同一个 Agent 会话；每条：每条消息开新会话",
          },
          h(Segmented, {
            value: val("sessionMode", "single"),
            options: [
              { value: "single", label: "单会话" },
              { value: "per-message", label: "每条" },
            ],
            onChange: function (v) {
              saveNow("sessionMode", v);
            },
          }),
        ),

        // 正在输入
        h(
          SettingRow,
          {
            label: h("span", null, "正在输入提示"),
            hint: "处理消息时向微信显示「正在输入」",
          },
          h(Toggle, {
            checked: val("typingIndicator", true) !== false,
            label: "正在输入提示",
            onChange: function (v) {
              saveNow("typingIndicator", v);
            },
          }),
        ),

        // 工具进度
        h(
          SettingRow,
          {
            label: h("span", null, "工具进度提示"),
            hint: "把工具调用进度作为中间消息发出，便于观察 Agent 在做什么",
          },
          h(Toggle, {
            checked: val("replyProgressMessages", true) !== false,
            label: "工具进度提示",
            onChange: function (v) {
              saveNow("replyProgressMessages", v);
            },
          }),
        ),

        // 思考过程
        h(
          SettingRow,
          {
            label: h("span", null, "发送思考过程"),
            hint: "把模型的 reasoning 内容一并发出，默认关闭；仅在调试提示词时需要",
          },
          h(Toggle, {
            checked: val("replyThinking", false) === true,
            label: "发送思考过程",
            onChange: function (v) {
              saveNow("replyThinking", v);
            },
          }),
        ),

        // 白名单
        h(
          "div",
          { style: styles.field },
          h(
            "div",
            { style: styles.rowText },
            h("span", { style: styles.label }, "用户白名单", customTag("allowFrom")),
            h(
              "span",
              { style: styles.hint },
              "只允许这些微信用户使用，多个用逗号分隔；留空表示不限制（仅单聊）",
            ),
          ),
          h("input", {
            type: "text",
            value: (function () {
              var list = val("allowFrom", []);
              return Array.isArray(list) ? list.join(", ") : String(list || "");
            })(),
            placeholder: "例如 wxid_abc123, wxid_def456",
            onChange: function (e) {
              saveLater("allowFrom", e.target.value);
            },
            style: Object.assign({}, styles.input, styles.mono),
          }),
        ),

        // 会话目录
        h(
          "div",
          { style: styles.field },
          h(
            "div",
            { style: styles.rowText },
            h("span", { style: styles.label }, "会话工作目录", customTag("session")),
            h(
              "span",
              { style: styles.hint },
              "Agent 在此目录下工作；留空使用 DSH 默认工作区（改动需重启生效）",
            ),
          ),
          h(TextInput, {
            value: String(val("sessionCwd", "") || ""),
            placeholder: "例如 D:\\Project\\my-app",
            onChange: function (v) {
              saveLater("sessionCwd", v);
            },
            style: styles.mono,
          }),
        ),

        // ===== 全局设定 =====
        h(
          "div",
          { style: styles.sectionTitle },
          "全局设定",
          h(
            "span",
            { style: styles.sectionHint },
            "注入到 Agent 系统提示，对所有微信会话生效",
          ),
        ),

        h(
          "div",
          { style: styles.field },
          h(
            "div",
            { style: styles.rowText },
            h("span", { style: styles.label }, "设定内容", customTag("globalPrompt")),
            h(
              "span",
              { style: styles.hint },
              "留空表示不注入。可用占位符：{{weixin.fromUserId}}、{{weixin.accountId}}、{{weixin.sessionId}}",
            ),
          ),
          h("textarea", {
            value: String(val("globalPrompt", "") || ""),
            placeholder: "例如：\n你正在通过微信与用户对话，回复请简短自然，不要使用 Markdown 表格。",
            rows: 7,
            onChange: function (e) {
              saveLater("globalPrompt", e.target.value);
            },
            style: Object.assign({}, styles.input, styles.textarea),
          }),
        ),

        // ===== 媒体 =====
        h(
          "div",
          { style: styles.sectionTitle },
          "媒体消息",
          h("span", { style: styles.sectionHint }, "图片、语音、文件、视频的收发"),
        ),

        h(
          SettingRow,
          {
            label: h("span", null, "接收媒体"),
            hint: "把微信发来的图片/语音/文件下载到本地，并把路径告诉 Agent",
          },
          h(Toggle, {
            checked: val("mediaInbound", true) !== false,
            label: "接收媒体",
            onChange: function (v) {
              saveNow("mediaInbound", v);
            },
          }),
        ),

        h(
          SettingRow,
          {
            label: h("span", null, "发送媒体"),
            hint: "Agent 回复里提到的本地文件会自动上传并发回微信",
          },
          h(Toggle, {
            checked: val("mediaOutbound", true) !== false,
            label: "发送媒体",
            onChange: function (v) {
              saveNow("mediaOutbound", v);
            },
          }),
        ),

        needsRestart.length > 0
          ? h(
              "p",
              { style: styles.hint },
              "部分改动需重启 DSH 才完全生效：" + needsRestart.join("、"),
            )
          : null,
      );
    }

    // =======================================================================
    // 插件注册
    // =======================================================================

    /** 侧栏入口依赖的面板列表与布局服务。 */
    var inject = ["slots", "layout"];

    /**
     * 注册侧栏图标与主面板。
     *
     * @param {object} ctx - 浏览器端 cordis 上下文
     * @returns {void}
     */
    function apply(ctx) {
      // 主面板：keyed slot，key 与侧栏 id 一致
      ctx.slots.inject("main", function () {
        return ctx.slots.register(
          { name: "main", key: PANEL_ID },
          WeixinPanelPage,
        );
      });

      // 侧栏图标：list slot
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: "微信",
          },
          WeixinPanelIcon,
        );
      });
    }

    /**
     * 侧栏图标组件。
     *
     * @param {object} props - 组件属性
     * @param {number} props.size - 图标边长
     * @param {boolean} props.active - 是否选中
     * @returns {object} React 元素
     */
    function WeixinPanelIcon(props) {
      return h(WeixinIcon, { size: props.size, active: props.active });
    }

    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
