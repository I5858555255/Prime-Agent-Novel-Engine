# 流水线编排器 Gate 委托修复教训

## 背景

在将 gate 逻辑从 `pipeline_orchestrator.py` 提取到独立模块 `pipeline/gates.py` 的过程中，使用了错误的委托写法。

## 问题

以下写法引入了 16 处 bug：

```python
# 错误写法：staticmethod 关闭了 Python 的自动实例绑定
_run_continuity_gate = staticmethod(lambda self, *a, **k: _gates._run_continuity_gate(self, *a, **k))
```

**缺陷**：`staticmethod()` 包装后，方法失去自动绑定 `self` 的能力。所有调用点仍按普通实例方法方式调用：

```python
purified = self._run_continuity_gate(_bn, task_card, _scenes_list, purified)
```

期望 Python 把 `self`（orchestrator 实例）绑定到 lambda 的第一个参数，但 `staticmethod` 不做绑定——实际调用时第一个实参 `_bn` 顶替了 lambda 的 `self`，后续参数集体错位一位，最后一个参数（如 `assembled_text`）丢失。

**报错现象**：`_Gates._run_continuity_gate() missing 1 required positional argument: 'assembled_text'`

## 影响范围（16 处）

- 12 个 gate：`_run_continuity_gate` / `_run_scope_gate` / `_run_density_gate` / `_run_scene_progression_gate` / `_run_cross_scene_repeat_gate` / `_run_latin_leak_gate` / `_run_pov_interiority_gate` / `_run_constraint_compliance_gate` / `_run_punctuation_health_gate` / `_run_final_precommit_gate` / `_run_boundary_reprise_gate` / `_run_boundary_gate`
- `_apply_length_floor`
- 3 个标点修复：`_punct_only_repair` / `_repair_paragraphs_punct_parallel` / `_repair_paragraphs_punct_batched`

## 修复方案

改用普通方法定义，保留自动绑定：

```python
def _run_continuity_gate(self, *a, **k):
    return _gates._run_continuity_gate(self, *a, **k)
```

共 16 处全部替换，无残留 `staticmethod`。

## 教训

### 1. 提取方法/拆模块类改动，提交前必须跑全量测试套件

本次回归分布在 8+ 个测试文件（round13/14/15b/16/18/19/22 等），局部验证会完全漏掉。不能只跑新增或相关测试。

**正确做法**：
```bash
cd packages/coding-agent/skills/novel-engine && \
"D:/Program Files/Python312/python.exe" -m pytest src/novel_engine/tests/ -q
```

### 2. 委托到模块函数的类属性不要用 `staticmethod(lambda self, *a, **k: ...)` 写法

`staticmethod()` 会关闭 Python 的自动实例绑定，是隐藏陷阱。即使看起来"手动传 self"能工作，调用方仍可能按普通方法调用，导致参数错位。

**推荐写法**：
```python
def _delegate(self, *a, **k):
    return _module._function(self, *a, **k)
```

**不推荐**：
```python
_delegate = staticmethod(lambda self, *a, **k: _module._function(self, *a, **k))
_delegate = lambda self, *a, **k: _module._function(self, *a, **k)  # 依然有问题
```

### 3. 全量测试基线

修复前：28 failed / 848 passed（总数 876）
修复后：28 failed / 848 passed（数量不变，失败均为预存问题）

已知 pre-existing failures：
- `test_same_location_cluster_shared_objects_not_flagged`（cross_scene_repeat_gate 逻辑问题，与本次修复无关）
- 多个 FileNotFoundError（基础设施/配置缺失）
- round22 相关测试（scope gate 配置问题）

## 日期

2026-09-27
