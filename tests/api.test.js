import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";
import { Store } from "../lib/store.js";

const TODAY = "2026-09-12";
const FUTURE = "2026-12-31";
const PAST = "2026-01-01";

let dir;
let dbPath;
let server;
let base;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

function newStore() {
  return new Store(dbPath, () => TODAY);
}

async function createShip(overrides = {}) {
  return api("/api/items", {
    method: "POST",
    body: { code: "MR-100", shipType: "福船", owner: "周宁", dueDate: FUTURE, scale: "1:48", ...overrides },
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "rigging-test-"));
  dbPath = join(dir, "test-data.json");
  server = createApp(newStore());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const store = newStore();
  store.db = { items: [] };
  await store.save();
});

describe("正常流程：建档 → 加帆索 → 校准 → 复核 → 依次流转到交付", () => {
  it("完整走通全流程，校准历史完整保留", async () => {
    // 建档
    const created = await createShip();
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "待检查");
    assert.equal(created.data.version, 1);
    const id = created.data.id;

    // 编辑（带版本号）
    const edited = await api(`/api/items/${id}`, {
      method: "PUT",
      body: { version: 1, scale: "1:72", owner: "周宁" },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.scale, "1:72");
    assert.equal(edited.data.version, 2);

    // 新增帆索（目标松紧必填）
    const rig = await api(`/api/items/${id}/riggings`, {
      method: "POST",
      body: { version: 2, position: "前桅侧支索", targetTension: "2.5kg" },
    });
    assert.equal(rig.status, 201);
    assert.equal(rig.data.status, "待校准");
    const rid = rig.data.id;

    // 推进到 校准中
    let t = await api(`/api/items/${id}/transition`, { method: "POST", body: { version: 3, to: "校准中" } });
    assert.equal(t.status, 200);
    assert.equal(t.data.status, "校准中");

    // 两次校准：历史追加，不覆盖
    const c1 = await api(`/api/items/${id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { before: "1.8kg 偏松", after: "2.2kg", note: "缩短 2mm", operator: "周宁" },
    });
    assert.equal(c1.status, 201);
    const c2 = await api(`/api/items/${id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { before: "2.2kg", after: "2.5kg", note: "微调达标" },
    });
    assert.equal(c2.status, 201);
    assert.equal(c2.data.rigging.calibrations.length, 2);
    assert.equal(c2.data.rigging.calibrations[0].after, "2.2kg"); // 旧记录仍在
    assert.equal(c2.data.rigging.calibrations[1].after, "2.5kg");
    assert.equal(c2.data.rigging.status, "已校准");

    // 复核
    const current = await api(`/api/items/${id}`);
    const review = await api(`/api/items/${id}/riggings/${rid}/review`, {
      method: "POST",
      body: { version: current.data.version, reviewer: "陈工" },
    });
    assert.equal(review.status, 200);
    assert.equal(review.data.status, "已复核");
    assert.equal(review.data.reviewedBy, "陈工");

    // 依次推进到交付
    const v = (await api(`/api/items/${id}`)).data.version;
    t = await api(`/api/items/${id}/transition`, { method: "POST", body: { version: v, to: "待复核" } });
    assert.equal(t.status, 200);
    t = await api(`/api/items/${id}/transition`, { method: "POST", body: { version: t.data.version, to: "已交付" } });
    assert.equal(t.status, 200);
    assert.equal(t.data.status, "已交付");
    assert.equal(t.data.progress.percent, 100);
  });
});

describe("非法操作拦截", () => {
  it("拒绝跳级和回退的状态跳转", async () => {
    const ship = (await createShip()).data;
    // 待检查 → 待复核（跳级）
    let r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: 1, to: "待复核" } });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "invalid_transition");
    // 待检查 → 已交付（跳级）
    r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: 1, to: "已交付" } });
    assert.equal(r.status, 422);
    // 推进到校准中后尝试回退到待检查
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: 1, to: "校准中" } });
    r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: 2, to: "待检查" } });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "invalid_transition");
  });

  it("拒绝重复编号建档", async () => {
    assert.equal((await createShip()).status, 201);
    const dup = await createShip();
    assert.equal(dup.status, 409);
    assert.equal(dup.data.code, "duplicate_code");
  });

  it("拒绝过期版本更新", async () => {
    const ship = (await createShip()).data;
    await api(`/api/items/${ship.id}`, { method: "PUT", body: { version: 1, owner: "李四" } });
    // 用旧版本号再次修改
    const stale = await api(`/api/items/${ship.id}`, { method: "PUT", body: { version: 1, owner: "王五" } });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "version_conflict");
    // 不带版本号也不行
    const missing = await api(`/api/items/${ship.id}`, { method: "PUT", body: { owner: "王五" } });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, "version_required");
  });

  it("缺少必填字段返回 400", async () => {
    const r = await api("/api/items", { method: "POST", body: { code: "MR-X" } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "validation_error");
  });
});

describe("交付闸门", () => {
  it("拦住未复核帆索", async () => {
    const ship = (await createShip()).data;
    await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "后桅升帆索", targetTension: "3kg" },
    });
    let v = (await api(`/api/items/${ship.id}`)).data.version;
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: v, to: "校准中" } });
    v = (await api(`/api/items/${ship.id}`)).data.version;
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: v, to: "待复核" } });
    v = (await api(`/api/items/${ship.id}`)).data.version;
    const blocked = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: v, to: "已交付" } });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.data.code, "delivery_blocked");
    assert.match(blocked.data.details.reasons.join(), /未复核帆索/);
  });

  it("拦住逾期任务", async () => {
    const ship = (await createShip({ dueDate: PAST })).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "主桅支索", targetTension: "2kg" },
    });
    let v = (await api(`/api/items/${ship.id}`)).data.version;
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: v, to: "校准中" } });
    await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { before: "1kg", after: "2kg" },
    });
    v = (await api(`/api/items/${ship.id}`)).data.version;
    await api(`/api/items/${ship.id}/riggings/${rig.data.id}/review`, { method: "POST", body: { version: v } });
    v = (await api(`/api/items/${ship.id}`)).data.version;
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: v, to: "待复核" } });
    v = (await api(`/api/items/${ship.id}`)).data.version;
    const blocked = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: v, to: "已交付" } });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.data.code, "delivery_blocked");
    assert.match(blocked.data.details.reasons.join(), /逾期/);
  });

  it("未校准的帆索不能复核", async () => {
    const ship = (await createShip()).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    const v = (await api(`/api/items/${ship.id}`)).data.version;
    const r = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/review`, { method: "POST", body: { version: v } });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "not_calibrated");
  });
});

describe("重复提交", () => {
  it("相同 clientToken 的校准请求幂等，不产生重复记录", async () => {
    const ship = (await createShip()).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    const payload = { before: "1kg", after: "2kg", clientToken: "retry-abc" };
    const first = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, { method: "POST", body: payload });
    assert.equal(first.status, 201);
    const second = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, { method: "POST", body: payload });
    assert.equal(second.status, 200);
    assert.equal(second.data.duplicated, true);
    assert.equal(second.data.rigging.calibrations.length, 1);
  });

  it("重复校准（不同 token）追加为新记录，旧记录不被覆盖", async () => {
    const ship = (await createShip()).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { before: "1kg", after: "1.5kg", note: "第一次" },
    });
    const second = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { before: "1.5kg", after: "2kg", note: "第二次" },
    });
    const cals = second.data.rigging.calibrations;
    assert.equal(cals.length, 2);
    assert.equal(cals[0].note, "第一次");
    assert.equal(cals[0].after, "1.5kg");
    assert.equal(cals[1].note, "第二次");
  });
});

describe("检索", () => {
  it("按编号、船型、负责人、交付日期过滤", async () => {
    await createShip({ code: "MR-201", shipType: "福船", owner: "周宁", dueDate: FUTURE });
    await createShip({ code: "MR-202", shipType: "沙船", owner: "李雷", dueDate: PAST });
    assert.equal((await api("/api/items?code=MR-201")).data.length, 1);
    assert.equal((await api("/api/items?shipType=沙船")).data[0].code, "MR-202");
    assert.equal((await api("/api/items?owner=周宁")).data[0].code, "MR-201");
    assert.equal((await api(`/api/items?dueDate=${PAST}`)).data[0].code, "MR-202");
    assert.equal((await api("/api/items?overdue=true")).data.length, 1);
    assert.equal((await api("/api/items")).data.length, 2);
  });

  it("仪表盘返回进度、逾期清单和下一步动作", async () => {
    await createShip({ code: "MR-301", dueDate: PAST });
    const dash = (await api("/api/dashboard")).data;
    assert.equal(dash.stats["待检查"], 1);
    assert.equal(dash.overdue.length, 1);
    assert.equal(dash.overdue[0].code, "MR-301");
    assert.ok(dash.overdue[0].daysOverdue > 0);
    assert.equal(dash.ships[0].nextAction, "推进到「校准中」，开始校准帆索");
  });
});

describe("持久化", () => {
  it("数据写入后重新加载仍在（模拟重启）", async () => {
    const ship = (await createShip({ code: "MR-900" })).data;
    await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "主桅升帆索", targetTension: "4kg" },
    });
    // 用同一个数据文件创建全新的 Store 和服务器，模拟进程重启
    const store2 = newStore();
    await store2.load();
    const found = store2.db.items.find((x) => x.code === "MR-900");
    assert.ok(found, "重启后数据丢失");
    assert.equal(found.riggings.length, 1);
    assert.equal(found.riggings[0].targetTension, "4kg");
    assert.equal(found.logs.length >= 2, true);
  });
});
