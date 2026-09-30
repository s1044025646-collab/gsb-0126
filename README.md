# 一维切割排样与余料复用后端

本机运行的 TypeScript/Node.js/SQLite 示例后端，只提供 API、CLI、虚拟型材订单夹具和自动化测试；不包含网页，也不连接真实切割设备。

## 依赖

- Node.js 25+（使用内置实验性 `node:sqlite`）
- npm
- SQLite 数据库、WAL 文件和所有演示数据均位于本项目 `data/`

长度以毫米输入和展示，数据库内部固定使用千分之一毫米整数，避免浮点误差。

## 安装

```powershell
npm install
```

## 启动与停止

```powershell
npm start
npm stop
```

服务只监听 `127.0.0.1`，端口由系统自动分配；启动后写入 `data/server.json`，停止脚本只终止该文件记录的本项目进程。

## 自动化测试

```powershell
npm test
```

测试覆盖锯缝临界、混合长度、余料优先、重复确认、无解、并发争抢、逐棒长度守恒、订单数量、精确小例、事务回滚、迁移重复执行和重启持久化。

## 可重复演示

```powershell
npm run demo
```

演示每次重建 `data/demo.db`，展示求解、预留、逐棒确认、重复提交幂等、可复用余料生成及下一张订单优先使用余料。

## CLI

```powershell
npm run cli -- material AL "aluminium"
npm run cli -- bar B1 AL 1200
npm run cli -- order O1 AL P500 500 2 P300 300 1
npm run cli -- solve O1
npm run cli -- reserve 1
npm run cli -- confirm 1 0 demo-bar-0
npm run cli -- confirm 1 1 demo-bar-1
npm run cli -- unmet O1
npm run cli -- release 1
npm run cli -- list bars 1 20
npm run cli -- settings 3 10 300 reusable_only
```

## API

- `GET /health`
- `POST /materials`, `GET /materials?page=1&pageSize=20`
- `POST /bars`, `GET /bars`
- `POST /orders`, `GET /orders`, `GET /orders/:code`
- `POST /orders/:code/solve`, `GET /orders/:code/unmet`
- `GET /plans`, `GET /plans/:id`
- `POST /plans/:id/reserve`, `POST /plans/:id/release`
- `POST /plans/:id/bars/:position/confirm`
- `GET/PUT /settings`, `GET /cuts`

示例请求体：

```json
{"code":"B1","materialCode":"AL","length":1200}
```

```json
{"code":"O1","materialCode":"AL","items":[{"partCode":"P500","cutLength":500,"quantity":2}]}
```

```json
{"idempotencyKey":"demo-bar-0"}
```

错误响应统一为：

```json
{"error":{"code":"BAR_UNAVAILABLE","message":"one or more bars were taken by another reservation"}}
```

## 计量规则

每根棒先扣除端部修整量；相邻切件之间扣除一次锯缝。若尾段达到余料阈值，或设置为 `always`，最后一段需要切断分离，其锯缝计入损耗，余料为切断后剩余长度；否则不切断最后一段，尾段作为不可复用损耗处理。

优化目标依次为：减少新原料棒数量、减少不可复用损耗。小规模算例使用有界穷举证明最优；大规模使用 best-fit decreasing 启发式，并返回新原料棒数下界及未证明最优说明。
