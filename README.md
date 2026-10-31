# flowline-lab

**在端到端误差 ≤ 1e-6 的前提下，自适应步长 RK4 积分 12 条 3D 流线只需 21,816 次场求值，固定步长 RK4 基线需要 51,632 次——少 57.7%，中位耗时 1.54 ms vs 3.65 ms（2.37×）。** 数字由 `node bench/bench.mjs` 真实产生，写入 `bench/result.json`。

Upstream: none

本项目为原创：核心是一个可脱离浏览器运行的流线积分与管状几何库，外加一个用同一份代码在页面里实时复算的 three.js 查看器。

## 怎么跑（一条命令）

```bash
node tools/gen-sample.mjs && node bench/verify.mjs && node bench/bench.mjs
```

页面（可选，只做渲染）：

```bash
python3 -m http.server 4173   # 打开 http://localhost:4173
```

无构建步骤、无 npm 依赖；`index.html` 用 importmap 固定 three@0.160.0（jsDelivr CDN）。

## 证据

`node bench/verify.mjs`（全部断言打印实测值，退出码 0）：

```
PASS  rotor exact solution   err=7.19e-9 steps=164 evals=1980
PASS  coarse fixed step fails h=0.5 err=3.13e-3
PASS  resample spacing (0.1% tol) max|ds_i-ds|=2.79e-6
PASS  tube vertex count / triangle count / unit normals / index bounds
PASS  deterministic rerun    evals=2604 points=215
PASS  adaptive endpoint error <= 1e-6   worst=8.71e-7 over 8 seeds
PASS  adaptive uses fewer evals  median ratio=2.36x  evals 37528 -> 15924 (57.6% fewer)
PASS  data/field.json matches generator  seeds=48 identical=true
```

`bench/result.json` 摘要（12 条流线，`jet` 场，maxTime=4，目标误差 1e-6）：

| 指标 | 自适应 RK4 | 固定步长 RK4 基线 |
| --- | --- | --- |
| 场求值次数 | 21,816 | 51,632 |
| 步数 | 1,749（另拒绝 69 次） | 12,908 |
| 最大端点误差 | 8.715e-7 | 9.994e-7 |
| 中位耗时（7 次采样，内层 3 次） | 1.5411 ms | 3.6466 ms |
| 冷启动 | 2.0672 ms | — |

样本数 7，中位/最小/p95/stddev 全部在 `bench/result.json`。两次微基准的相对标准差为 10.1% 与 12.5%（略高于 10%）：单次负载仅 1.5–3.6 ms，受 OS 调度抖动影响；**主证据是确定性的场求值次数与误差上界，不依赖计时**。计时仅作辅助，重复跑数值会浮动。

## 核心逻辑（`src/core.mjs`，零依赖、零 DOM）

- `createField("jet")`：`v = (-y·s, x·s, 0.4)`，`s = 1 + 25·exp(-((z-0.4)/0.15)²)`——沿 z 方向 26× 速度反差的螺旋场。
- `integrateFixed`：固定步长 RK4（基线）。
- `integrateAdaptive`：步长加倍误差控制（1 全步 + 2 半步，12 次求值/试探），按 `err ≤ tol` 接受并指数调整步长。
- `minFixedSteps`：对基线做指数搜索 + 二分，求出达到同等端点误差所需的最少固定步数（这是对照基线的定义，代码在 `src/core.mjs` 内）。
- `endpointError` / `resampleByArcLength` / `tubeGeometry`（平行传输标架）/ `makeSeeds`（LCG）。

## 本轮创新

**新在哪**：把「自适应步长 RK4 的误差控制」与「可现场复算的工作量账本」绑在同一个 3D 场景里——页面拖动容差或流线数量时，用与 node 完全相同的 `core.mjs` 现场重算端点误差、自适应求值与固定步长基线求值，直接显示节省百分比；`bench/result.json` 的数字可用一条命令复现。
**和谁不一样**：常见的 three.js 流线 demo 只画线、不量化误差；常见的数值库只给数字、不渲染。这里两侧共用一份纯函数核心，误差与步数都可对照基线。
**凭什么以前做不到**：不是做不到，而是很少有人把「同等精度约束下的求值次数对照」做成浏览器内可拖动、可复算的一等公民；本项目的对照基线（最小固定步数）是搜索出来的，不是拍的。

## 已知限制

- `jet` 场是解析构造的，不代表真实 CFD 数据；换真实场只需替换 `createField` 的 `at`。
- 基线定义为「达到 ≤1e-6 端点误差的最少固定步数」，用二分搜索得到，因此基线本身也有 ±1 步的量化误差。
- 自适应在宽松容差（≥1e-5）下因每步 12 次求值的开销反而更慢；本仓库只声称 1e-6 精度区间的优势，`bench/result.json` 未测其他区间。
- 页面渲染 48 条管状流线，无阴影/后处理；移动端未适配。
