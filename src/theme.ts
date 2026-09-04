/**
 * Apple 风格共享主题 —— 三个 webview 共用的设计 tokens 与组件样式。
 * 浅色/深色主题分别定义变量，跟随 VS Code 主题自动切换。
 */

export const APPLE_CSS = `
:root{
  --radius-s:8px;
  --radius-m:12px;
  --radius-l:16px;
  --radius-pill:980px;
}
body.vscode-light{
  --accent:#007aff;
  --accent-hover:#0066d6;
  --accent-soft:rgba(0,122,255,.12);
  --bg:#f5f5f7;
  --card:#ffffff;
  --card-hover:#fafafc;
  --line:rgba(0,0,0,.08);
  --line-strong:rgba(0,0,0,.14);
  --text:#1d1d1f;
  --text-sub:#6e6e73;
  --text-weak:#98989d;
  --input:#ffffff;
  --chip-bg:rgba(0,0,0,.05);
  --glass:rgba(255,255,255,.72);
  --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);
  --shadow-pop:0 12px 40px rgba(0,0,0,.18);
}
body.vscode-dark, body.vscode-high-contrast{
  --accent:#0a84ff;
  --accent-hover:#3395ff;
  --accent-soft:rgba(10,132,255,.16);
  --bg:#1c1c1e;
  --card:#2c2c2e;
  --card-hover:#333336;
  --line:rgba(255,255,255,.1);
  --line-strong:rgba(255,255,255,.18);
  --text:#f5f5f7;
  --text-sub:#98989d;
  --text-weak:#6e6e73;
  --input:#3a3a3c;
  --chip-bg:rgba(255,255,255,.08);
  --glass:rgba(44,44,46,.8);
  --shadow:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.32);
  --shadow-pop:0 12px 40px rgba(0,0,0,.6);
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Segoe UI',var(--vscode-font-family),sans-serif;
  -webkit-font-smoothing:antialiased;
  color:var(--text);
  background:var(--bg);
}
::selection{background:var(--accent-soft)}

/* ---------- 卡片（半透明毛玻璃） ---------- */
.ap-card{
  background:var(--glass);
  backdrop-filter:blur(24px) saturate(180%);
  -webkit-backdrop-filter:blur(24px) saturate(180%);
  border:1px solid var(--line);
  border-radius:var(--radius-l);
  box-shadow:var(--shadow);
}
.ap-card.hoverable{transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease}
.ap-card.hoverable:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.1),0 16px 40px rgba(0,0,0,.08);border-color:var(--line-strong)}

/* ---------- 按钮（胶囊） ---------- */
.ap-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  padding:7px 16px;border-radius:var(--radius-pill);
  border:1px solid var(--line-strong);background:transparent;color:var(--text);
  font-size:12.5px;font-weight:500;cursor:pointer;user-select:none;
  font-family:inherit;transition:background .15s ease,color .15s ease,border-color .15s ease,opacity .15s ease;
}
.ap-btn:hover{background:var(--chip-bg)}
.ap-btn:active{opacity:.7}
.ap-btn:disabled{opacity:.45;cursor:not-allowed}
.ap-btn-primary{background:var(--accent);border-color:transparent;color:#fff}
.ap-btn-primary:hover{background:var(--accent-hover)}
.ap-btn-success{background:#34c759;border-color:transparent;color:#fff}
.ap-btn-success:hover{background:#2db84e}
.ap-btn-ghost{border-color:var(--line);color:var(--text-sub);background:transparent}
.ap-btn-ghost:hover{color:var(--text);background:var(--chip-bg)}
.ap-btn-sm{padding:5px 12px;font-size:11.5px;gap:4px}
.ap-btn-icon{padding:7px;width:30px;height:30px;border-color:var(--line);color:var(--text-sub)}
.ap-btn-icon:hover{color:var(--text);background:var(--chip-bg)}

/* ---------- 输入框（圆角搜索框） ---------- */
.ap-input{
  width:100%;padding:8px 14px;
  background:var(--input);
  border:1px solid var(--line);
  border-radius:var(--radius-pill);
  color:var(--text);font-size:12.5px;font-family:inherit;outline:none;
  transition:border-color .15s ease, box-shadow .15s ease;
}
.ap-input::placeholder{color:var(--text-weak)}
.ap-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}

/* ---------- 分段控件（segmented control） ---------- */
.ap-seg{
  display:inline-flex;align-items:center;
  background:var(--chip-bg);
  border-radius:var(--radius-pill);
  padding:2.5px;gap:2px;
}
.ap-seg span{
  padding:4px 13px;border-radius:var(--radius-pill);
  font-size:11.5px;color:var(--text-sub);cursor:pointer;user-select:none;
  transition:background .18s ease,color .18s ease,box-shadow .18s ease;
}
.ap-seg span:hover{color:var(--text)}
.ap-seg span.active{
  background:var(--card);color:var(--text);font-weight:600;
  box-shadow:0 1px 3px rgba(0,0,0,.16),0 1px 1px rgba(0,0,0,.06);
}

/* ---------- 文本层级 ---------- */
.ap-title{font-weight:700;letter-spacing:-.01em;color:var(--text)}
.ap-sub{color:var(--text-sub)}
.ap-faint{color:var(--text-weak)}
.ap-mono{font-family:var(--vscode-editor-font-family,monospace)}

/* ---------- 徽章 ---------- */
.ap-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 10px;border-radius:var(--radius-pill);font-size:10.5px;font-weight:600}
.ap-badge.green{background:rgba(52,199,89,.15);color:#34c759}
.ap-badge.orange{background:rgba(255,149,0,.15);color:#ff9500}
.ap-badge.red{background:rgba(255,59,48,.15);color:#ff3b30}

/* ---------- 图标 ---------- */
.ico{width:14px;height:14px;flex-shrink:0;vertical-align:-2px}

/* ---------- 提示条 ---------- */
.ap-note{
  display:flex;gap:8px;align-items:flex-start;
  padding:10px 14px;border-radius:var(--radius-m);
  background:rgba(255,149,0,.1);border:1px solid rgba(255,149,0,.35);
  color:var(--text);font-size:12px;line-height:1.6;
}
.ap-note .ico{margin-top:2px;color:#ff9500}

/* ---------- 加载动画 ---------- */
.ap-spinner{width:14px;height:14px;border:2px solid var(--line-strong);border-top-color:var(--accent);border-radius:50%;animation:apspin .8s linear infinite}
@keyframes apspin{to{transform:rotate(360deg)}}

/* ---------- 弹层（设置面板等） ---------- */
.ap-pop{
  background:var(--glass);backdrop-filter:blur(24px) saturate(180%);
  -webkit-backdrop-filter:blur(24px) saturate(180%);
  border:1px solid var(--line);
  border-radius:var(--radius-l);
  box-shadow:var(--shadow-pop);
}

/* ---------- 表单字段 ---------- */
.ap-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.ap-field label{font-size:11.5px;font-weight:600;color:var(--text-sub)}
.ap-field .hint{font-size:10.5px;color:var(--text-weak);line-height:1.5}
.ap-select{
  width:100%;padding:8px 12px;border-radius:var(--radius-m);
  background:var(--input);border:1px solid var(--line);color:var(--text);
  font-size:12.5px;font-family:inherit;outline:none;
}
.ap-select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}

/* ---------- 分隔线 ---------- */
.ap-divider{height:1px;background:var(--line);border:none;margin:14px 0}
`;
