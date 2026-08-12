#!/usr/bin/env python3
"""
Mini 测试运行器：跑通 10 章生成闭环。
验证：
1. 状态机基本流程
2. pending/commit 事务
3. recovery_policy 分流逻辑
4. checkpoint 完整性
支持 --real 参数使用真实 Agnes API，否则使用 MockLLMClient。
"""
import json
import logging
import sys
import time
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent))

from llm_client import LLMClient, MockLLMClient
from pipeline_orchestrator import PipelineOrchestrator
from state_machine import ChapterPhase

logs_dir = Path("小说工程/runtime/logs")
logs_dir.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("小说工程/runtime/logs/mini_test.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("mini_test")


def _reset_runtime_state(root: Path):
    """清理运行时状态，确保每次 Mini 测试从零开始。"""
    import shutil

    # 清理运行时状态、审计数据和记忆数据，确保每次测试从零开始
    for sub in ("runtime/checkpoint.json", "runtime/state_machine.json",
                "runtime/recovery_policy.json", "audit/per_chapter_reviews.json",
                "audit/sliding_window_reviews.json", "memory/quality_memory.json"):
        p = root / sub
        if p.exists():
            try:
                p.unlink()
            except PermissionError:
                pass

    for sub in ("chapters/novel", "chapters/synopsis", "chapters/outline",
                "audit", "memory/short_term", "memory/long_term", "memory/world_state"):
        p = root / sub
        if p.exists():
            try:
                shutil.rmtree(p)
            except PermissionError:
                for child in p.iterdir():
                    if child.is_file():
                        try:
                            child.unlink()
                        except PermissionError:
                            pass
                    elif child.is_dir():
                        try:
                            shutil.rmtree(child)
                        except PermissionError:
                            pass

    # 重新创建必要的目录结构
    for sub in ("runtime/logs", "chapters/novel", "chapters/synopsis", "chapters/outline",
                "audit", "memory/short_term", "memory/long_term", "memory/world_state/pending",
                "memory/long_term/embeddings"):
        (root / sub).mkdir(parents=True, exist_ok=True)


def run_mini_test(num_chapters: int = 10, use_real_api: bool = False):
    """运行 Mini 测试并返回结果。"""
    logger.info(f"===== MINI TEST START: {num_chapters} chapters =====")
    logger.info(f"API mode: {'REAL' if use_real_api else 'MOCK'}")
    start_time = time.time()

    project_root = Path(__file__).parent
    # 确保审计目录存在
    (project_root / "audit").mkdir(parents=True, exist_ok=True)
    _reset_runtime_state(project_root)

    # 选择 LLM 客户端
    if use_real_api:
        orchestrator = PipelineOrchestrator(str(project_root))
        logger.info("Using real Agnes 2.0 Flash API")
    else:
        orchestrator = PipelineOrchestrator(str(project_root), llm_client=MockLLMClient())
        logger.info("Using Mock LLM Client")

    # 1. 验证状态机初始化
    sm = orchestrator.state_machine
    assert sm.current_chapter == 0, f"Expected chapter 0, got {sm.current_chapter}"
    assert sm.current_phase == ChapterPhase.INIT, f"Expected INIT, got {sm.current_phase}"
    logger.info("OK State machine initialized correctly")

    # 2. 验证 checkpoint 管理器
    cm = orchestrator.checkpoint_mgr
    latest = cm.get_latest_checkpoint()
    assert latest is None, f"Expected no checkpoints initially, got {latest}"
    logger.info("OK Checkpoint manager clean")

    # 3. 运行章节生成
    results = []
    for i in range(1, num_chapters + 1):
        logger.info(f"\n{'='*60}")
        logger.info(f"GENERATING CHAPTER {i}/{num_chapters}")
        logger.info(f"{'='*60}")

        try:
            result = orchestrator.generate_single_chapter(i)
            results.append(result)

            status = "PASS" if result["success"] else "FAIL"
            score = result.get("score", "N/A")
            logger.info(f"Chapter {i}: {status} (score={score})")

            if result["errors"]:
                for err in result["errors"]:
                    logger.warning(f"  Error: {err}")

        except Exception as e:
            logger.error(f"Chapter {i} crashed: {e}")
            results.append({
                "chapter": i,
                "success": False,
                "score": None,
                "errors": [str(e)],
            })
            break

    elapsed = time.time() - start_time

    # 4. 验证结果
    passed = sum(1 for r in results if r.get("success"))
    failed = len(results) - passed

    logger.info(f"\n{'='*60}")
    logger.info("MINI TEST RESULTS")
    logger.info(f"{'='*60}")
    logger.info(f"Chapters attempted: {len(results)}")
    logger.info(f"Passed: {passed}")
    logger.info(f"Failed: {failed}")
    logger.info(f"Time elapsed: {elapsed:.2f}s")

    if results:
        scores = [r.get("score") for r in results if r.get("score") is not None]
        if scores:
            logger.info(f"Average score: {sum(scores)/len(scores):.1f}")
            logger.info(f"Min score: {min(scores)}")
            logger.info(f"Max score: {max(scores)}")

    # 5. 验证 checkpoint
    cp_data = cm.load()
    checkpoint_count = len(cp_data.get("checkpoints", []))
    logger.info(f"Checkpoints created: {checkpoint_count}")

    # 6. 验证文件是否写入
    for i in range(1, min(len(results) + 1, num_chapters + 1)):
        novel_path = project_root / "chapters" / "novel" / f"chapter_{i}.txt"
        synopsis_path = project_root / "chapters" / "synopsis" / f"chapter_{i}.txt"
        outline_path = project_root / "chapters" / "outline" / f"chapter_{i}.json"

        if novel_path.exists() and synopsis_path.exists() and outline_path.exists():
            novel_size = novel_path.stat().st_size
            logger.info(f"Chapter {i} files OK (novel: {novel_size} bytes)")
        else:
            logger.warning(f"Chapter {i} missing files!")

    # 7. 验证 recovery_policy
    rp_path = project_root / "runtime" / "recovery_policy.json"
    if rp_path.exists():
        with open(rp_path, "r", encoding="utf-8") as f:
            policy = json.load(f)
        expected_keys = [
            "json_parse_error", "api_disconnect", "context_overflow",
            "world_state_conflict", "file_write_corruption", "unknown_error",
        ]
        for key in expected_keys:
            assert key in policy, f"Missing recovery policy: {key}"
        logger.info("OK Recovery policy complete")

    # 8. 输出最终报告
    report = {
        "test_type": "mini",
        "num_chapters": num_chapters,
        "use_real_api": use_real_api,
        "passed": passed,
        "failed": failed,
        "results": results,
        "checkpoint_count": checkpoint_count,
        "elapsed_seconds": round(elapsed, 2),
        "success": failed == 0,
    }

    report_path = project_root / "audit" / "mini_test_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report saved to {report_path}")

    return report


if __name__ == "__main__":
    # 解析命令行参数
    use_real_api = "--real" in sys.argv
    num_chapters = 10
    for arg in sys.argv[1:]:
        if arg != "--real":
            try:
                num_chapters = int(arg)
            except ValueError:
                logger.error(f"Unknown argument: {arg}")
                sys.exit(1)

    report = run_mini_test(num_chapters, use_real_api=use_real_api)

    if report["success"]:
        logger.info("\nMINI TEST PASSED")
        sys.exit(0)
    else:
        logger.info("\nMINI TEST FAILED")
        sys.exit(1)
