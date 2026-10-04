# sologsb-1122 隧道掌子面地质编录台（gbtunnelface）

面向隧道施工地质人员的掌子面编录工作台：逐循环编录围岩级别、岩性、节理产状与涌水情况，绘制岩性素描并用数字表示结构面，实时按 BQ 指标判定围岩级别并给出支护建议。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21822**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（素描线段），含结构版本号与升级迁移 |
| 并发模型 | 版本化里程链（乐观并发 + 区间重叠检测 + 冲突草稿 + 确认后联动重算） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1122/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{face,joint,grade,water,chain}.ts
        ├── stores/{face,joint,grade,chainStore}.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard,CommitConfirmDialog,ConflictPanel}.vue
        ├── hooks/{useFaceFilter,useGradeCalc,useFaceSubmit}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge}.vue
        └── utils/{db,geoMath,chain,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 六张表：`faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）、`meta`（里程链全局版本）、`drafts`（提交冲突保留的草稿）。
- **版本化里程链**：`meta.chainRevision` 每次成功提交递增；掌子面 / 节理 / 涌水 / 级别均带版本戳（所依据的链版本、自身记录版本、依据区间）。
  - 提交（新建 / 修改里程 / 待整理激活）先在事务内与前后区间比较：区间重叠、编号重复或编辑期间链版本已被他人推进（stale）时**不覆盖任何数据**，把内容连同冲突清单存入 `drafts`，在台账顶部列出，可调整后重提、「仍按此里程」或丢弃。
  - 无冲突时弹出**重算确认**：相邻区间边界对齐、目标掌子面节理/涌水按区间比例 remap（越界钳制并提示）、全部涌水点沿新链重算推导趋势；确认弹窗逐项列出变化后才提交。确认提交时会在事务内再次复检，防止两个页面同时确认。
  - 人工确认的围岩级别结论**永不被里程重算覆盖**，详情页 / 判定页显示结论所依据的链版本与区间；引用旧链版本的节理、涌水用红色「旧桩号 / vN」标记。
  - 涌水同时保留人工填写趋势 `changeTrend` 与链上推导趋势 `derivedTrend`，趋势折线、突变点检测使用推导值，二者在清单中并排显示。
- v2 → v3 迁移：为掌子面 / 节理 / 涌水 / 级别补齐版本戳，为老节理补 `chainage`、为涌水补 `derivedTrend`（沿里程重算）；区间互相重叠的旧掌子面**标记为 pending 进入「里程待整理」**而不是丢弃，调整区间后可激活入链。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，刷新后仍在。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 3 个掌子面（其中 ZK-101 为区间重叠的「待整理」示例）、5 组节理、2 条级别判定（含 1 条人工确认）、3 条涌水记录与 1 条冲突草稿。

## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。
