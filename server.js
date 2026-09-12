import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, STAGES, Store } from "./lib/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = join(__dirname, "data", "model-rigging-calibration.json");

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准工作台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:16px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:20px; padding:20px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 4px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; margin-top:10px; }
    button.secondary { background:#69736a; } button.small { padding:5px 10px; margin-top:0; font-size:13px; }
    button:disabled { background:#b7beb4; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; align-items:end; }
    .toolbar label { margin:0; } .toolbar input { min-width:130px; width:auto; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:12px; }
    .warn { color:var(--warn); font-weight:700; }
    .overdue-panel { border-color:var(--warn); margin-bottom:14px; }
    .overdue-panel h2 { color:var(--warn); }
    .progress { height:8px; background:#e4e9e1; border-radius:99px; overflow:hidden; }
    .progress > div { height:100%; background:var(--accent); }
    .rigging { border:1px solid var(--line); border-radius:6px; padding:10px; display:grid; gap:6px; }
    .logs { border-top:1px dashed var(--line); padding-top:6px; max-height:120px; overflow:auto; font-size:12px; }
    .next { background:#eef3ea; border-radius:6px; padding:8px; font-size:13px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .error { color:var(--warn); font-size:13px; min-height:1em; }
    @media (max-width:900px){ header{display:block;padding:16px;} main{grid-template-columns:1fr;padding:14px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索校准工作台</h1><div class="meta">建档 → 校准 → 复核 → 交付，状态只能依次推进</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm">
        <h2 id="formTitle">新增模型</h2>
        <input type="hidden" name="editingId">
        <label>模型编号 *</label><input name="code" required>
        <label>船型 *</label><input name="shipType" required>
        <label>比例</label><input name="scale" placeholder="如 1:48">
        <label>桅杆数量</label><input name="mastCount" type="number" min="0">
        <label>帆索材料</label><input name="riggingMaterial">
        <label>负责人 *</label><input name="owner" required>
        <label>交付日期 *</label><input name="dueDate" type="date" required>
        <div class="row"><button type="submit">保存</button><button type="button" class="secondary" id="cancelEdit">取消编辑</button></div>
        <div class="error" id="formError"></div>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel overdue-panel" id="overduePanel" style="display:none"><h2>逾期清单</h2><div id="overdueList"></div></div>
      <div class="panel">
        <h2>检索</h2>
        <div class="toolbar">
          <div><label>编号</label><input id="fCode"></div>
          <div><label>船型</label><input id="fShipType"></div>
          <div><label>负责人</label><input id="fOwner"></div>
          <div><label>交付日期</label><input id="fDueDate" type="date"></div>
          <div><label>状态</label><select id="fStatus"><option value="">全部</option>${STAGES.map((s) => "<option>" + s + "</option>").join("")}</select></div>
          <button class="small" id="searchBtn">检索</button>
          <button class="small secondary" id="resetBtn">重置</button>
        </div>
      </div>
      <div class="grid" id="cards" style="margin-top:14px"></div>
    </section>
  </main>
  <script>
    const STAGES = ${JSON.stringify(STAGES)};
    let ships = [];
    const $ = (s) => document.querySelector(s);
    async function api(path, options = {}) {
      const res = await fetch(path, options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const e = new Error(data.error || '请求失败'); e.details = data.details; throw e; }
      return data;
    }
    function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    async function load() {
      const params = new URLSearchParams();
      if ($('#fCode').value) params.set('code', $('#fCode').value);
      if ($('#fShipType').value) params.set('shipType', $('#fShipType').value);
      if ($('#fOwner').value) params.set('owner', $('#fOwner').value);
      if ($('#fDueDate').value) params.set('dueDate', $('#fDueDate').value);
      if ($('#fStatus').value) params.set('status', $('#fStatus').value);
      const dash = await api('/api/dashboard');
      ships = await api('/api/items?' + params);
      renderStats(dash.stats);
      renderOverdue(dash.overdue);
      renderCards();
    }

    function renderStats(stats) {
      $('#stats').innerHTML = Object.entries(stats).map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join('');
    }
    function renderOverdue(list) {
      $('#overduePanel').style.display = list.length ? '' : 'none';
      $('#overdueList').innerHTML = list.map(o =>
        '<div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding:6px 0">' +
        '<span><b>' + esc(o.code) + '</b> ' + esc(o.shipType) + ' · ' + esc(o.owner) + ' · 交付期 ' + o.dueDate + '</span>' +
        '<span class="warn">逾期 ' + o.daysOverdue + ' 天</span></div>' +
        '<div class="meta">下一步：' + esc(o.nextAction) + '</div>').join('');
    }
    function renderCards() {
      $('#cards').innerHTML = ships.map(cardHtml).join('') || '<div class="panel meta">没有符合条件的模型</div>';
      ships.forEach(ship => {
        const bind = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
        bind('#adv-' + ship.id, () => advance(ship));
        bind('#edit-' + ship.id, () => startEdit(ship));
        const addForm = $('#addrig-' + ship.id);
        if (addForm) addForm.onsubmit = (e) => addRigging(e, ship);
        ship.riggings.forEach(r => {
          const calForm = $('#cal-' + r.id);
          if (calForm) calForm.onsubmit = (e) => calibrate(e, ship, r);
          const revBtn = $('#rev-' + r.id);
          if (revBtn) revBtn.onclick = () => review(ship, r);
        });
      });
    }
    // 推进前置条件：待检查→校准中 需有帆索；校准中→待复核 需全部已校准；待复核→已交付 需全部已复核且未逾期
    function canAdvance(ship) {
      if (ship.status === '待检查') return ship.riggings.length > 0;
      if (ship.status === '校准中') return ship.riggings.length > 0 && ship.riggings.every(r => r.status !== '待校准');
      if (ship.status === '待复核') return ship.riggings.length > 0 && ship.riggings.every(r => r.status === '已复核') && !ship.overdue;
      return false;
    }
    function cardHtml(ship) {
      const p = ship.progress;
      const riggings = ship.riggings.map(r => {
        const cals = r.calibrations.map(c =>
          '<div>#' + esc(c.id.slice(-4)) + ' ' + esc(c.at.slice(0, 10)) + ' ' + esc(c.before) + ' → <b>' + esc(c.after) + '</b>' +
          (c.note ? ' · ' + esc(c.note) : '') + ' · ' + esc(c.operator) + '</div>').join('');
        const calForm = r.status !== '已复核' && ship.status === '校准中'
          ? '<form id="cal-' + r.id + '" class="row">' +
            '<input name="before" placeholder="调整前值" required style="width:110px">' +
            '<input name="after" placeholder="调整后值" required style="width:110px">' +
            '<input name="note" placeholder="备注" style="width:110px">' +
            '<button class="small">记录校准</button></form>' : '';
        const revBtn = r.status === '已校准' && ship.status === '待复核'
          ? '<button class="small secondary" id="rev-' + r.id + '">复核通过</button>'
          : (r.status === '已复核' ? '<span class="pill">已复核 · ' + esc(r.reviewedBy || '') + '</span>' : '');
        return '<div class="rigging"><div class="row" style="justify-content:space-between"><b>' + esc(r.position) + '</b><span class="pill">' + r.status + '</span></div>' +
          '<div class="meta">目标松紧：' + esc(r.targetTension) + '</div>' +
          '<div class="logs">' + (cals || '暂无校准记录') + '</div>' + calForm + '<div class="row">' + revBtn + '</div></div>';
      }).join('');
      const next = STAGES[STAGES.indexOf(ship.status) + 1];
      const allowed = canAdvance(ship);
      const advBtn = next
        ? '<button class="small" id="adv-' + ship.id + '"' + (allowed ? '' : ' disabled title="不满足推进条件，见上方下一步提示"') + '>推进到「' + next + '」</button>'
        : '';
      const editBtn = ship.status !== '已交付' ? '<button class="small secondary" id="edit-' + ship.id + '">编辑</button>' : '';
      const addForm = ['待检查', '校准中'].includes(ship.status)
        ? '<form id="addrig-' + ship.id + '" class="row"><input name="position" placeholder="索具位置" required style="width:130px">' +
          '<input name="targetTension" placeholder="目标松紧" required style="width:130px"><button class="small">添加帆索</button></form>' : '';
      const logs = ship.logs.slice(-5).reverse().map(l => '<div>' + esc(l.at.slice(0, 10)) + ' ' + esc(l.step) + '：' + esc(l.note) + '</div>').join('');
      return '<article class="card">' +
        '<div class="row" style="justify-content:space-between"><h3>' + esc(ship.code) + ' · ' + esc(ship.shipType) + '</h3><span class="pill">' + ship.status + '</span></div>' +
        '<div class="meta">负责人 ' + esc(ship.owner) + ' · 交付期 ' + ship.dueDate + (ship.overdue ? ' <span class="warn">已逾期</span>' : '') +
        ' · 比例 ' + esc(ship.scale || '-') + ' · v' + ship.version + '</div>' +
        '<div class="row"><div class="progress" style="flex:1"><div style="width:' + p.percent + '%"></div></div><span class="meta">' + p.reviewed + '/' + p.total + ' 已复核</span></div>' +
        '<div class="next">下一步：' + esc(ship.nextAction) + '</div>' +
        '<div class="row">' + advBtn + editBtn + '</div>' + riggings + addForm +
        '<div class="logs meta">' + (logs || '') + '</div></article>';
    }

    async function run(fn) { try { await fn(); await load(); } catch (e) { alert(e.message); } }
    function advance(ship) {
      const next = STAGES[STAGES.indexOf(ship.status) + 1];
      run(() => api('/api/items/' + ship.id + '/transition', { method: 'POST', body: JSON.stringify({ version: ship.version, to: next }) }));
    }
    function startEdit(ship) {
      const f = $('#createForm');
      f.editingId.value = ship.id; f.code.value = ship.code; f.code.disabled = true;
      f.shipType.value = ship.shipType; f.scale.value = ship.scale || ''; f.mastCount.value = ship.mastCount ?? '';
      f.riggingMaterial.value = ship.riggingMaterial || ''; f.owner.value = ship.owner; f.dueDate.value = ship.dueDate;
      $('#formTitle').textContent = '编辑模型 ' + ship.code + '（v' + ship.version + '）';
      window.scrollTo(0, 0);
    }
    function resetForm() {
      const f = $('#createForm'); f.reset(); f.editingId.value = ''; f.code.disabled = false;
      $('#formTitle').textContent = '新增模型'; $('#formError').textContent = '';
    }
    function addRigging(e, ship) {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      run(() => api('/api/items/' + ship.id + '/riggings', { method: 'POST', body: JSON.stringify({ ...data, version: ship.version }) }));
    }
    function calibrate(e, ship, r) {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.version = ship.version;
      data.clientToken = ship.id + '-' + r.id + '-' + Date.now();
      run(() => api('/api/items/' + ship.id + '/riggings/' + r.id + '/calibrations', { method: 'POST', body: JSON.stringify(data) }));
    }
    function review(ship, r) {
      run(() => api('/api/items/' + ship.id + '/riggings/' + r.id + '/review', { method: 'POST', body: JSON.stringify({ version: ship.version }) }));
    }

    $('#createForm').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      const data = Object.fromEntries(new FormData(f).entries());
      const editing = f.editingId.value;
      const ship = ships.find(s => s.id === editing);
      run(async () => {
        if (editing && ship) {
          await api('/api/items/' + editing, { method: 'PUT', body: JSON.stringify({ ...data, version: ship.version }) });
        } else {
          await api('/api/items', { method: 'POST', body: JSON.stringify(data) });
        }
        resetForm();
      }).then(() => {}).catch(() => {});
    };
    $('#cancelEdit').onclick = resetForm;
    $('#searchBtn').onclick = load;
    $('#resetBtn').onclick = () => { ['#fCode', '#fShipType', '#fOwner', '#fDueDate', '#fStatus'].forEach(s => $(s).value = ''); load(); };
    $('#reload').onclick = load;
    load();
  </script>
</body>
</html>`;
}

export function createApp(store) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      await store.init();

      if (req.method === "GET" && path === "/") return html(res, page());

      if (req.method === "GET" && path === "/api/items") {
        const { code, shipType, owner, dueDate, status, overdue } = Object.fromEntries(url.searchParams);
        return send(res, 200, store.queryItems({ code, shipType, owner, dueDate, status, overdue }));
      }
      if (req.method === "POST" && path === "/api/items") {
        const input = await readBody(req);
        const item = await store.transact(() => store.createItem(input));
        return send(res, 201, store.summarize(item));
      }
      if (req.method === "GET" && path === "/api/dashboard") {
        return send(res, 200, store.dashboard());
      }

      const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
      if (itemMatch && req.method === "GET") {
        return send(res, 200, store.summarize(store.findItem(decodeURIComponent(itemMatch[1]))));
      }
      if (itemMatch && req.method === "PUT") {
        const input = await readBody(req);
        const item = await store.transact(() => store.updateItem(decodeURIComponent(itemMatch[1]), input));
        return send(res, 200, store.summarize(item));
      }

      const transition = path.match(/^\/api\/items\/([^/]+)\/transition$/);
      if (transition && req.method === "POST") {
        const input = await readBody(req);
        const item = await store.transact(() => store.transition(decodeURIComponent(transition[1]), input));
        return send(res, 200, store.summarize(item));
      }

      const riggings = path.match(/^\/api\/items\/([^/]+)\/riggings$/);
      if (riggings && req.method === "POST") {
        const input = await readBody(req);
        const rigging = await store.transact(() => store.addRigging(decodeURIComponent(riggings[1]), input));
        return send(res, 201, rigging);
      }

      const calibrations = path.match(/^\/api\/items\/([^/]+)\/riggings\/([^/]+)\/calibrations$/);
      if (calibrations && req.method === "POST") {
        const input = await readBody(req);
        const result = await store.transact(() =>
          store.addCalibration(decodeURIComponent(calibrations[1]), decodeURIComponent(calibrations[2]), input)
        );
        return send(res, result.duplicated ? 200 : 201, result);
      }

      const review = path.match(/^\/api\/items\/([^/]+)\/riggings\/([^/]+)\/review$/);
      if (review && req.method === "POST") {
        const input = await readBody(req);
        const rigging = await store.transact(() =>
          store.reviewRigging(decodeURIComponent(review[1]), decodeURIComponent(review[2]), input)
        );
        return send(res, 200, rigging);
      }

      send(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, { error: error.message, code: error.code, details: error.details });
      } else {
        send(res, 500, { error: error.message });
      }
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 3038);
  const store = new Store(process.env.DATA_FILE || defaultDbPath);
  createApp(store).listen(port, () => console.log("古船模型帆索校准工作台 listening on http://localhost:" + port));
}
