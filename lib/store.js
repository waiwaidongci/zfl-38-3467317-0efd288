import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export const STAGES = ["待检查", "校准中", "待复核", "已交付"];
export const RIGGING_STAGES = ["待校准", "已校准", "已复核"];

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const REQUIRED_FIELDS = ["code", "shipType", "owner", "dueDate"];
const EDITABLE_FIELDS = ["shipType", "scale", "mastCount", "riggingMaterial", "owner", "dueDate"];

function isDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export class Store {
  /**
   * @param {string} path JSON 数据文件路径
   * @param {() => string} [todayFn] 返回 YYYY-MM-DD 的时钟，测试可注入固定日期
   */
  constructor(path, todayFn) {
    this.path = path;
    this.today = todayFn || (() => new Date().toISOString().slice(0, 10));
    this.db = null;
    this.seq = 0;
    this.tmpSeq = 0;
    // 写事务串行队列：并发请求排队执行，杜绝读-改-写交错丢数据
    this._tail = Promise.resolve();
  }

  /** 进程内只加载一次；之后内存即权威数据，落盘由 transact 负责 */
  async init() {
    if (!this.db) await this.load();
    return this.db;
  }

  /**
   * 串行执行「修改 + 落盘」。fn 抛错时不保存，队列继续运转。
   * 并发请求按到达顺序逐个应用，互不覆盖。
   */
  transact(fn) {
    const run = async () => {
      await this.init();
      const result = await fn();
      await this.save();
      return result;
    };
    const result = this._tail.then(run);
    this._tail = result.catch(() => {});
    return result;
  }

  async load() {
    if (!existsSync(this.path)) {
      await mkdir(dirname(this.path), { recursive: true });
      this.db = { items: [] };
      await this.save();
    } else {
      this.db = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(this.db.items)) this.db.items = [];
      this.db.items.forEach((item) => this.migrateItem(item));
    }
    return this.db;
  }

  /** 兼容旧版数据：补齐字段，把旧的 tasks 结构升级为 riggings */
  migrateItem(item) {
    item.id ||= this.nextId("MR");
    item.version = Number.isInteger(item.version) && item.version > 0 ? item.version : 1;
    item.status = STAGES.includes(item.status) ? item.status : STAGES[0];
    item.logs = Array.isArray(item.logs) ? item.logs : [];
    item.createdAt ||= this.now();
    item.updatedAt ||= item.createdAt;
    if (!Array.isArray(item.riggings)) {
      const legacy = Array.isArray(item.tasks) ? item.tasks : [];
      item.riggings = legacy.map((t) => ({
        id: t.id || this.nextId("R"),
        position: t.position || "未命名帆索",
        targetTension: t.targetTension || t.tension || "未设定",
        status: t.reviewedAt ? "已复核" : (t.logs || []).length ? "已校准" : "待校准",
        calibrations: (t.logs || []).map((l) => ({
          id: this.nextId("C"),
          at: l.at || item.createdAt,
          before: t.tension || "未记录",
          after: l.note || "未记录",
          note: l.note || "",
          operator: item.owner || "",
          clientToken: null,
        })),
        reviewedAt: t.reviewedAt || null,
        reviewedBy: t.reviewedBy || null,
      }));
      delete item.tasks;
    }
  }

  async save() {
    // 每次保存用独立临时文件，避免并发/重入时互相截断或 rename 冲突
    this.tmpSeq += 1;
    const tmp = `${this.path}.${process.pid}.${this.tmpSeq}.tmp`;
    await writeFile(tmp, JSON.stringify(this.db, null, 2));
    await rename(tmp, this.path); // 原子替换，避免写一半损坏数据
  }

  now() {
    return new Date().toISOString();
  }

  nextId(prefix) {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq}`;
  }

  findItem(idOrCode) {
    const item = this.db.items.find((x) => x.id === idOrCode || x.code === idOrCode);
    if (!item) throw new ApiError(404, "item_not_found", `未找到模型 ${idOrCode}`);
    return item;
  }

  checkVersion(item, version) {
    if (version === undefined || version === null) {
      throw new ApiError(400, "version_required", "请求必须携带当前版本号 version");
    }
    if (Number(version) !== item.version) {
      throw new ApiError(409, "version_conflict", `版本已过期：当前版本 ${item.version}，提交版本 ${version}，请刷新后重试`);
    }
  }

  log(item, step, note) {
    item.logs.push({ at: this.now(), step, note });
  }

  touch(item) {
    item.version += 1;
    item.updatedAt = this.now();
  }

  // ---------- 模型建档 / 编辑 / 检索 ----------

  createItem(input) {
    for (const field of REQUIRED_FIELDS) {
      if (!input[field] || String(input[field]).trim() === "") {
        throw new ApiError(400, "validation_error", `缺少必填字段：${field}`);
      }
    }
    if (!isDateString(input.dueDate)) {
      throw new ApiError(400, "validation_error", "交付日期 dueDate 必须是 YYYY-MM-DD");
    }
    const code = String(input.code).trim();
    if (this.db.items.some((x) => x.code === code)) {
      throw new ApiError(409, "duplicate_code", `编号 ${code} 已存在，不能重复建档`);
    }
    const item = {
      id: this.nextId("MR"),
      code,
      shipType: String(input.shipType).trim(),
      scale: input.scale ? String(input.scale).trim() : "",
      mastCount: input.mastCount === undefined || input.mastCount === "" ? null : Number(input.mastCount),
      riggingMaterial: input.riggingMaterial ? String(input.riggingMaterial).trim() : "",
      owner: String(input.owner).trim(),
      dueDate: input.dueDate,
      status: STAGES[0],
      version: 1,
      riggings: [],
      logs: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.log(item, "建档", `创建模型 ${code}（${item.shipType}），负责人 ${item.owner}`);
    this.db.items.unshift(item);
    return item;
  }

  updateItem(idOrCode, input) {
    const item = this.findItem(idOrCode);
    this.checkVersion(item, input.version);
    if (item.status === "已交付") {
      throw new ApiError(422, "already_delivered", "已交付的模型不能再编辑");
    }
    if (input.dueDate !== undefined && !isDateString(input.dueDate)) {
      throw new ApiError(400, "validation_error", "交付日期 dueDate 必须是 YYYY-MM-DD");
    }
    const changed = [];
    for (const field of EDITABLE_FIELDS) {
      if (input[field] !== undefined && input[field] !== item[field]) {
        item[field] = field === "mastCount" ? (input[field] === "" ? null : Number(input[field])) : String(input[field]).trim();
        changed.push(field);
      }
    }
    this.log(item, "编辑", changed.length ? `修改字段：${changed.join("、")}` : "无字段变化");
    this.touch(item);
    return item;
  }

  queryItems(filters = {}) {
    const norm = (v) => String(v || "").trim().toLowerCase();
    let items = this.db.items;
    if (filters.code) items = items.filter((x) => norm(x.code).includes(norm(filters.code)));
    if (filters.shipType) items = items.filter((x) => norm(x.shipType).includes(norm(filters.shipType)));
    if (filters.owner) items = items.filter((x) => norm(x.owner).includes(norm(filters.owner)));
    if (filters.dueDate) items = items.filter((x) => x.dueDate === filters.dueDate);
    if (filters.status) items = items.filter((x) => x.status === filters.status);
    if (filters.overdue === true || filters.overdue === "true") items = items.filter((x) => this.isOverdue(x));
    return items.map((item) => this.summarize(item));
  }

  // ---------- 状态机：待检查 → 校准中 → 待复核 → 已交付 ----------

  transition(idOrCode, input) {
    const item = this.findItem(idOrCode);
    this.checkVersion(item, input.version);
    const to = input.to;
    const idx = STAGES.indexOf(item.status);
    const next = STAGES[idx + 1];
    if (!STAGES.includes(to) || to !== next) {
      throw new ApiError(
        422,
        "invalid_transition",
        `非法状态跳转：${item.status} 只能推进到 ${next || "（已是终态）"}，不能跳到 ${to}`
      );
    }
    if (to === "校准中" && item.riggings.length === 0) {
      throw new ApiError(422, "no_riggings", "进入「校准中」前至少需要添加一根帆索");
    }
    if (to === "已交付") {
      const reasons = this.deliveryBlockers(item);
      if (reasons.length) {
        throw new ApiError(422, "delivery_blocked", "交付被拦截：" + reasons.join("；"), { reasons });
      }
    }
    const from = item.status;
    item.status = to;
    this.log(item, "状态流转", `${from} → ${to}`);
    this.touch(item);
    return item;
  }

  deliveryBlockers(item) {
    const reasons = [];
    if (!item.riggings.length) reasons.push("没有任何帆索记录");
    const unreviewed = item.riggings.filter((r) => r.status !== "已复核");
    if (unreviewed.length) {
      reasons.push(`未复核帆索：${unreviewed.map((r) => r.position).join("、")}`);
    }
    if (this.isOverdue(item)) reasons.push(`任务已逾期（交付日期 ${item.dueDate}）`);
    return reasons;
  }

  isOverdue(item) {
    return item.status !== "已交付" && !!item.dueDate && this.today() > item.dueDate;
  }

  // ---------- 帆索与校准记录 ----------

  addRigging(idOrCode, input) {
    const item = this.findItem(idOrCode);
    this.checkVersion(item, input.version);
    if (!["待检查", "校准中"].includes(item.status)) {
      throw new ApiError(422, "invalid_stage", `当前状态为「${item.status}」，帆索只能在「待检查」或「校准中」阶段添加`);
    }
    if (!input.position || !String(input.position).trim()) {
      throw new ApiError(400, "validation_error", "缺少必填字段：position（索具位置）");
    }
    if (!input.targetTension || !String(input.targetTension).trim()) {
      throw new ApiError(400, "validation_error", "缺少必填字段：targetTension（目标松紧）");
    }
    const rigging = {
      id: this.nextId("R"),
      position: String(input.position).trim(),
      targetTension: String(input.targetTension).trim(),
      status: "待校准",
      calibrations: [],
      reviewedAt: null,
      reviewedBy: null,
    };
    item.riggings.push(rigging);
    this.log(item, "新增帆索", `${rigging.position}，目标松紧 ${rigging.targetTension}`);
    this.touch(item);
    return rigging;
  }

  findRigging(item, riggingId) {
    const rigging = item.riggings.find((r) => r.id === riggingId);
    if (!rigging) throw new ApiError(404, "rigging_not_found", `未找到帆索 ${riggingId}`);
    return rigging;
  }

  /**
   * 追加一次校准记录。历史只增不改：重复校准会新增一条记录，绝不覆盖旧记录。
   * 必须携带当前版本号；唯一例外是 clientToken 幂等重放——同一 token 的重复
   * 提交直接返回首次已落库的记录，不再校验版本也不产生重复数据。
   */
  addCalibration(idOrCode, riggingId, input) {
    const item = this.findItem(idOrCode);
    const rigging = this.findRigging(item, riggingId);
    if (input.clientToken) {
      const existing = rigging.calibrations.find((c) => c.clientToken === input.clientToken);
      if (existing) return { rigging, calibration: existing, duplicated: true };
    }
    this.checkVersion(item, input.version);
    if (item.status !== "校准中") {
      throw new ApiError(422, "invalid_stage", `当前状态为「${item.status}」，校准只允许在「校准中」阶段进行`);
    }
    if (rigging.status === "已复核") {
      throw new ApiError(422, "already_reviewed", `帆索 ${rigging.position} 已复核，不能再追加校准`);
    }
    for (const field of ["before", "after"]) {
      if (!input[field] || !String(input[field]).trim()) {
        throw new ApiError(400, "validation_error", `缺少必填字段：${field}（调整${field === "before" ? "前" : "后"}值）`);
      }
    }
    const calibration = {
      id: this.nextId("C"),
      at: this.now(),
      before: String(input.before).trim(),
      after: String(input.after).trim(),
      note: input.note ? String(input.note).trim() : "",
      operator: input.operator ? String(input.operator).trim() : item.owner,
      clientToken: input.clientToken || null,
    };
    rigging.calibrations.push(calibration);
    rigging.status = "已校准";
    this.log(item, "校准", `${rigging.position}：${calibration.before} → ${calibration.after}（目标 ${rigging.targetTension}）`);
    this.touch(item);
    return { rigging, calibration, duplicated: false };
  }

  reviewRigging(idOrCode, riggingId, input) {
    const item = this.findItem(idOrCode);
    this.checkVersion(item, input.version);
    const rigging = this.findRigging(item, riggingId);
    if (item.status !== "待复核") {
      throw new ApiError(422, "invalid_stage", `当前状态为「${item.status}」，复核只允许在「待复核」阶段进行`);
    }
    if (rigging.status === "已复核") {
      throw new ApiError(422, "already_reviewed", `帆索 ${rigging.position} 已复核，不能重复复核`);
    }
    if (!rigging.calibrations.length) {
      throw new ApiError(422, "not_calibrated", `帆索 ${rigging.position} 还没有校准记录，不能复核`);
    }
    rigging.status = "已复核";
    rigging.reviewedAt = this.now();
    rigging.reviewedBy = input.reviewer ? String(input.reviewer).trim() : item.owner;
    this.log(item, "复核", `${rigging.position} 复核通过（${rigging.reviewedBy}）`);
    this.touch(item);
    return rigging;
  }

  // ---------- 汇总：进度 / 逾期 / 下一步 ----------

  summarize(item) {
    const total = item.riggings.length;
    const reviewed = item.riggings.filter((r) => r.status === "已复核").length;
    const calibrated = item.riggings.filter((r) => r.status !== "待校准").length;
    return {
      ...item,
      overdue: this.isOverdue(item),
      progress: {
        total,
        calibrated,
        reviewed,
        percent: total ? Math.round((reviewed / total) * 100) : 0,
      },
      nextAction: this.nextAction(item),
    };
  }

  nextAction(item) {
    switch (item.status) {
      case "待检查":
        return item.riggings.length ? "推进到「校准中」，开始校准帆索" : "先添加帆索，再推进到「校准中」";
      case "校准中": {
        const pending = item.riggings.filter((r) => r.status === "待校准");
        if (pending.length) return `校准帆索：${pending.map((r) => r.position).join("、")}`;
        return "推进到「待复核」，然后复核帆索";
      }
      case "待复核": {
        const unreviewed = item.riggings.filter((r) => r.status !== "已复核");
        if (unreviewed.length) return `复核帆索：${unreviewed.map((r) => r.position).join("、")}`;
        if (this.isOverdue(item)) return `已逾期（${item.dueDate}），交付被拦截，请先调整交付日期`;
        return "全部帆索已复核，可以交付";
      }
      case "已交付":
        return "已交付，流程结束";
      default:
        return "";
    }
  }

  dashboard() {
    const items = this.db.items;
    const stats = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const item of items) stats[item.status] = (stats[item.status] || 0) + 1;
    const overdue = items
      .filter((item) => this.isOverdue(item))
      .map((item) => ({
        id: item.id,
        code: item.code,
        shipType: item.shipType,
        owner: item.owner,
        dueDate: item.dueDate,
        status: item.status,
        daysOverdue: Math.floor((Date.parse(this.today()) - Date.parse(item.dueDate)) / 86400000),
        nextAction: this.nextAction(item),
      }));
    return { stats, overdue, ships: items.map((item) => this.summarize(item)) };
  }
}
