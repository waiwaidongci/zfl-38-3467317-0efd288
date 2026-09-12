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
let store;
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

async function versionOf(id) {
  return (await api(`/api/items/${id}`)).data.version;
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
  store = newStore();
  server = createApp(store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
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
    let t = await api(`/api/items/${id}/transition`, { method: "POST", body: { version: await versionOf(id), to: "校准中" } });
    assert.equal(t.status, 200);
    assert.equal(t.data.status, "校准中");

    // 两次校准：历史追加，不覆盖
    const c1 = await api(`/api/items/${id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(id), before: "1.8kg 偏松", after: "2.2kg", note: "缩短 2mm", operator: "周宁" },
    });
    assert.equal(c1.status, 201);
    const c2 = await api(`/api/items/${id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(id), before: "2.2kg", after: "2.5kg", note: "微调达标" },
    });
    assert.equal(c2.status, 201);
    assert.equal(c2.data.rigging.calibrations.length, 2);
    assert.equal(c2.data.rigging.calibrations[0].after, "2.2kg"); // 旧记录仍在
    assert.equal(c2.data.rigging.calibrations[1].after, "2.5kg");
    assert.equal(c2.data.rigging.status, "已校准");

    // 复核只能在「待复核」阶段：先推进状态
    t = await api(`/api/items/${id}/transition`, { method: "POST", body: { version: await versionOf(id), to: "待复核" } });
    assert.equal(t.status, 200);
    const review = await api(`/api/items/${id}/riggings/${rid}/review`, {
      method: "POST",
      body: { version: await versionOf(id), reviewer: "陈工" },
    });
    assert.equal(review.status, 200);
    assert.equal(review.data.status, "已复核");
    assert.equal(review.data.reviewedBy, "陈工");

    // 依次推进到交付
    t = await api(`/api/items/${id}/transition`, { method: "POST", body: { version: await versionOf(id), to: "已交付" } });
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
    // 推进到校准中后尝试回退到待检查（先加帆索满足进入校准中的前提）
    await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "校准中" } });
    r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "待检查" } });
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
  });

  it("所有修改都必须携带当前版本号", async () => {
    const ship = (await createShip()).data;
    // 编辑不带版本
    let r = await api(`/api/items/${ship.id}`, { method: "PUT", body: { owner: "王五" } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "version_required");
    // 状态推进不带版本
    r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { to: "校准中" } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "version_required");
    // 新增帆索不带版本
    r = await api(`/api/items/${ship.id}/riggings`, { method: "POST", body: { position: "前桅支索", targetTension: "2kg" } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "version_required");
    // 校准不带版本
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    r = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { before: "1kg", after: "2kg" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "version_required");
    // 复核不带版本
    r = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/review`, { method: "POST", body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "version_required");
  });

  it("缺少必填字段返回 400", async () => {
    const r = await api("/api/items", { method: "POST", body: { code: "MR-X" } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "validation_error");
  });
});

describe("阶段门禁", () => {
  async function shipWithRigging() {
    const ship = (await createShip()).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    return { ship, rid: rig.data.id };
  }
  async function gotoStage(id, target) {
    while (true) {
      const cur = (await api(`/api/items/${id}`)).data;
      if (cur.status === target) return cur;
      const next = ["待检查", "校准中", "待复核", "已交付"][["待检查", "校准中", "待复核", "已交付"].indexOf(cur.status) + 1];
      const r = await api(`/api/items/${id}/transition`, { method: "POST", body: { version: cur.version, to: next } });
      assert.equal(r.status, 200, `推进到 ${next} 失败：${JSON.stringify(r.data)}`);
    }
  }

  it("待检查：禁止校准、禁止复核、无帆索禁止进入校准中、允许加帆索", async () => {
    const ship = (await createShip()).data;
    // 没有帆索时不能进入校准中
    let r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: 1, to: "校准中" } });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "no_riggings");
    // 允许加帆索
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    assert.equal(rig.status, 201);
    // 待检查阶段校准被拒绝
    r = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1kg", after: "2kg" },
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "invalid_stage");
    assert.match(r.data.error, /校准中/);
    // 待检查阶段复核被拒绝
    r = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/review`, {
      method: "POST",
      body: { version: await versionOf(ship.id) },
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "invalid_stage");
    assert.match(r.data.error, /待复核/);
  });

  it("校准中：允许校准和补帆索、禁止复核", async () => {
    const { ship, rid } = await shipWithRigging();
    await gotoStage(ship.id, "校准中");
    // 允许校准
    let r = await api(`/api/items/${ship.id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1kg", after: "2kg" },
    });
    assert.equal(r.status, 201);
    // 允许补帆索
    r = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: await versionOf(ship.id), position: "后桅支索", targetTension: "3kg" },
    });
    assert.equal(r.status, 201);
    // 禁止复核
    r = await api(`/api/items/${ship.id}/riggings/${rid}/review`, {
      method: "POST",
      body: { version: await versionOf(ship.id) },
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "invalid_stage");
  });

  it("待复核：允许复核、禁止补帆索、禁止校准", async () => {
    const { ship, rid } = await shipWithRigging();
    await gotoStage(ship.id, "校准中");
    await api(`/api/items/${ship.id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1kg", after: "2kg" },
    });
    await gotoStage(ship.id, "待复核");
    // 禁止补帆索
    let r = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: await versionOf(ship.id), position: "后桅支索", targetTension: "3kg" },
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "invalid_stage");
    // 禁止校准
    r = await api(`/api/items/${ship.id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "2kg", after: "2.5kg" },
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "invalid_stage");
    // 允许复核
    r = await api(`/api/items/${ship.id}/riggings/${rid}/review`, {
      method: "POST",
      body: { version: await versionOf(ship.id) },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "已复核");
  });

  it("已交付：一切修改都被拒绝", async () => {
    const { ship, rid } = await shipWithRigging();
    await gotoStage(ship.id, "校准中");
    await api(`/api/items/${ship.id}/riggings/${rid}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1kg", after: "2kg" },
    });
    await gotoStage(ship.id, "待复核");
    await api(`/api/items/${ship.id}/riggings/${rid}/review`, {
      method: "POST",
      body: { version: await versionOf(ship.id) },
    });
    await gotoStage(ship.id, "已交付");
    const v = await versionOf(ship.id);
    for (const [path, body] of [
      [`/api/items/${ship.id}/riggings`, { version: v, position: "x", targetTension: "1kg" }],
      [`/api/items/${ship.id}/riggings/${rid}/calibrations`, { version: v, before: "1kg", after: "2kg" }],
      [`/api/items/${ship.id}/riggings/${rid}/review`, { version: v }],
    ]) {
      const r = await api(path, { method: "POST", body });
      assert.equal(r.status, 422, `${path} 应被拒绝`);
      assert.equal(r.data.code, "invalid_stage");
    }
  });
  it("进入待复核前：帆索未全部校准则被拦截，全部校准后放行", async () => {
    const ship = (await createShip()).data;
    await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: await versionOf(ship.id), position: "后桅升帆索", targetTension: "3kg" },
    });
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "校准中" } });
    // 只校准一根，推进待复核被拒，错误里列出未校准的帆索
    const list = (await api(`/api/items/${ship.id}`)).data.riggings;
    const [r1] = list;
    await api(`/api/items/${ship.id}/riggings/${r1.id}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1kg", after: "2kg" },
    });
    let r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "待复核" } });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "uncalibrated_riggings");
    assert.match(r.data.error, /后桅升帆索/);
    assert.deepEqual(r.data.details.positions, ["后桅升帆索"]);
    // 状态没有被推进
    assert.equal((await api(`/api/items/${ship.id}`)).data.status, "校准中");
    // 校准剩余帆索后放行
    const r2 = list[1];
    await api(`/api/items/${ship.id}/riggings/${r2.id}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "2kg", after: "3kg" },
    });
    r = await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "待复核" } });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "待复核");
  });
});

describe("交付闸门", () => {
  it("拦住未复核帆索", async () => {
    const ship = (await createShip()).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "后桅升帆索", targetTension: "3kg" },
    });
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "校准中" } });
    await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "2kg", after: "3kg" },
    });
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "待复核" } });
    const blocked = await api(`/api/items/${ship.id}/transition`, {
      method: "POST",
      body: { version: await versionOf(ship.id), to: "已交付" },
    });
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
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "校准中" } });
    await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1kg", after: "2kg" },
    });
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "待复核" } });
    await api(`/api/items/${ship.id}/riggings/${rig.data.id}/review`, {
      method: "POST",
      body: { version: await versionOf(ship.id) },
    });
    const blocked = await api(`/api/items/${ship.id}/transition`, {
      method: "POST",
      body: { version: await versionOf(ship.id), to: "已交付" },
    });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.data.code, "delivery_blocked");
    assert.match(blocked.data.details.reasons.join(), /逾期/);
  });

  it("未校准的帆索不能复核（防御性检查，直接构造待复核状态）", async () => {
    // 正常流程已无法带着未校准帆索进入待复核，这里直接落库构造该状态，验证复核接口的防线
    const ship = (await createShip()).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    const stored = store.db.items.find((x) => x.id === ship.id);
    stored.status = "待复核";
    await store.save();
    const r = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/review`, {
      method: "POST",
      body: { version: await versionOf(ship.id) },
    });
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
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "校准中" } });
    const payload = { version: await versionOf(ship.id), before: "1kg", after: "2kg", clientToken: "retry-abc" };
    const first = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, { method: "POST", body: payload });
    assert.equal(first.status, 201);
    // 原样重放（版本号已过期）：幂等命中，返回首次记录而不是报版本冲突
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
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "校准中" } });
    await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1kg", after: "1.5kg", note: "第一次" },
    });
    const second = await api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
      method: "POST",
      body: { version: await versionOf(ship.id), before: "1.5kg", after: "2kg", note: "第二次" },
    });
    const cals = second.data.rigging.calibrations;
    assert.equal(cals.length, 2);
    assert.equal(cals[0].note, "第一次");
    assert.equal(cals[0].after, "1.5kg");
    assert.equal(cals[1].note, "第二次");
  });
});

describe("并发写入", () => {
  it("并发建档不丢记录、不出服务端错误", async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => createShip({ code: `MR-C${String(i).padStart(3, "0")}` }))
    );
    const statuses = results.map((r) => r.status);
    assert.deepEqual([...new Set(statuses)], [201], `出现非 201 响应：${statuses.join(",")}`);
    // 内存中 20 条全在
    const list = await api("/api/items");
    assert.equal(list.data.length, N);
    assert.equal(new Set(list.data.map((x) => x.code)).size, N);
    // 磁盘上同样 20 条（模拟重启后也不丢）
    const store2 = newStore();
    await store2.load();
    assert.equal(store2.db.items.length, N);
  });

  it("并发修改同一模型：一个成功，其余收到版本冲突，数据不被覆盖", async () => {
    const ship = (await createShip()).data;
    const results = await Promise.all([
      api(`/api/items/${ship.id}`, { method: "PUT", body: { version: 1, owner: "张三" } }),
      api(`/api/items/${ship.id}`, { method: "PUT", body: { version: 1, owner: "李四" } }),
      api(`/api/items/${ship.id}`, { method: "PUT", body: { version: 1, owner: "王五" } }),
    ]);
    const byStatus = (s) => results.filter((r) => r.status === s);
    assert.equal(byStatus(200).length, 1);
    assert.equal(byStatus(409).length, 2);
    const final = await api(`/api/items/${ship.id}`);
    assert.equal(final.data.version, 2); // 只应用了一次修改
    assert.ok(["张三", "李四", "王五"].includes(final.data.owner));
  });

  it("并发校准同一帆索：版本冲突被串行拦截，历史不错乱", async () => {
    const ship = (await createShip()).data;
    const rig = await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "前桅支索", targetTension: "2kg" },
    });
    await api(`/api/items/${ship.id}/transition`, { method: "POST", body: { version: await versionOf(ship.id), to: "校准中" } });
    const v = await versionOf(ship.id);
    const results = await Promise.all([
      api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
        method: "POST",
        body: { version: v, before: "1kg", after: "1.5kg" },
      }),
      api(`/api/items/${ship.id}/riggings/${rig.data.id}/calibrations`, {
        method: "POST",
        body: { version: v, before: "1.5kg", after: "2kg" },
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 1);
    const final = await api(`/api/items/${ship.id}`);
    assert.equal(final.data.riggings[0].calibrations.length, 1);
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
    assert.equal(dash.ships[0].nextAction, "先添加帆索，再推进到「校准中」");
  });
});

describe("持久化", () => {
  it("数据写入后重新加载仍在（模拟重启）", async () => {
    const ship = (await createShip({ code: "MR-900" })).data;
    await api(`/api/items/${ship.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "主桅升帆索", targetTension: "4kg" },
    });
    // 用同一个数据文件创建全新的 Store，模拟进程重启
    const store2 = newStore();
    await store2.load();
    const found = store2.db.items.find((x) => x.code === "MR-900");
    assert.ok(found, "重启后数据丢失");
    assert.equal(found.riggings.length, 1);
    assert.equal(found.riggings[0].targetTension, "4kg");
    assert.equal(found.logs.length >= 2, true);
  });

  it("旧版数据（tasks 结构、无版本号）加载时自动迁移", async () => {
    // 直接把旧格式数据写到磁盘
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      dbPath,
      JSON.stringify({
        items: [
          {
            code: "MR-OLD",
            shipType: "福船",
            owner: "周宁",
            dueDate: FUTURE,
            status: "校准中",
            tasks: [{ id: "T-1", position: "前桅侧支索", tension: "偏松", logs: [{ at: "2026-06-12", note: "已缩短2mm" }] }],
            logs: [],
          },
        ],
      })
    );
    // 模拟重启：清空内存缓存，下次请求从磁盘加载并迁移
    store.db = null;
    const list = await api("/api/items?code=MR-OLD");
    assert.equal(list.data.length, 1);
    const item = list.data[0];
    assert.ok(item.id, "迁移后应补上 id");
    assert.equal(item.version, 1);
    assert.equal(item.riggings.length, 1);
    assert.equal(item.riggings[0].position, "前桅侧支索");
    assert.equal(item.riggings[0].calibrations.length, 1);
    // 迁移后可以正常走新流程
    const rig = await api(`/api/items/${item.id}/riggings`, {
      method: "POST",
      body: { version: 1, position: "后桅支索", targetTension: "2kg" },
    });
    assert.equal(rig.status, 201);
  });
});
