# 古船模型帆索校准工作台

古船模型帆索校准的建档、校准、复核、交付管理工作台。

## 运行

```bash
npm start        # 启动服务，访问 http://localhost:3038
npm test         # 运行自动化测试（node:test，零依赖）
```

数据保存在 `data/model-rigging-calibration.json`，原子写入，重启后仍在。可用 `PORT`、`DATA_FILE` 环境变量覆盖端口和数据文件。

## 功能

- **建档 / 编辑 / 检索**：模型编号唯一；可按编号、船型、负责人、交付日期、状态、是否逾期检索。
- **状态机**：`待检查 → 校准中 → 待复核 → 已交付`，只能依次推进，跳级、回退均被接口拒绝（422）。
- **帆索校准**：每根帆索有目标松紧；每次校准记录调整前/后值、备注、操作人、时间，历史只追加不覆盖；带 `clientToken` 的重复提交幂等。
- **交付闸门**：存在未复核帆索或任务已逾期时，交付被拦截（422 `delivery_blocked`，附原因清单）。
- **工作台页面**：每艘船的复核进度条、逾期清单（含逾期天数）、下一步动作提示。
- **并发保护**：所有修改必须携带当前 `version`，过期版本返回 409 `version_conflict`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/items?code=&shipType=&owner=&dueDate=&status=&overdue=` | 检索模型（含进度、下一步动作） |
| POST | `/api/items` | 建档（重复编号 409） |
| GET | `/api/items/:id` | 单个模型详情 |
| PUT | `/api/items/:id` | 编辑（需 `version`） |
| POST | `/api/items/:id/transition` | 状态推进 `{version, to}` |
| POST | `/api/items/:id/riggings` | 新增帆索 `{version, position, targetTension}` |
| POST | `/api/items/:id/riggings/:rid/calibrations` | 追加校准记录 `{before, after, note?, clientToken?}` |
| POST | `/api/items/:id/riggings/:rid/review` | 复核帆索 `{version, reviewer?}` |
| GET | `/api/dashboard` | 状态统计、逾期清单、各船进度 |

## 结构

- `server.js` — HTTP 服务与工作台页面
- `lib/store.js` — 领域逻辑：状态机、版本锁、交付闸门、持久化、旧数据迁移
- `tests/api.test.js` — 覆盖正常流程、非法跳转、重复编号、过期版本、交付拦截、重复提交、检索、持久化
