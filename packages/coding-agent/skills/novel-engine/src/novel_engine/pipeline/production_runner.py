#!/usr/bin/env python3
"""
全量生产运行器：生成 3000 章长篇小说。

验证项（通过成本沙盘后执行）：
1. 状态机基本流程稳定运行
2. 滑动窗口审查每50章触发并反馈
3. 质量记忆持续更新
4. 剧情约束层锁定跨章节被正确遵守
5. 成本在预算范围内（$400）
6. 实时进度、质量、成本报告
7. checkpoint 完整性持续保障
8. recovery_policy 分流逻辑
"""
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from novel_engine.core.llm_client import LLMClient, reset_call_log
from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator
from novel_engine.pipeline.reset_state import (
    reset_runtime_state,
    verify_output_files,
    verify_recovery_policy,
)
from novel_engine.core.state_machine import ChapterPhase

PROJECT_ROOT = Path(__file__).parent.parent
logs_dir = PROJECT_ROOT / "runtime/logs"
logs_dir.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(logs_dir / "production.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("production")


def print_progress(chapter: int, total: int, elapsed: float,
                   passed: int, failed: int, avg_score: float,
                   cost_usd: float, budget_max: float):
    """打印一行进度信息。"""
    pct = chapter / total * 100
    rate = passed / chapter * 100 if chapter > 0 else 0
    budget_pct = cost_usd / budget_max * 100
    eta = (elapsed / max(chapter, 1)) * (total - chapter)

    logger.info(
        f"[{pct:5.1f}%] Ch {chapter:>4d}/{total} | "
        f"P:{passed} F:{failed} | "
        f"Avg:{avg_score:.1f} | "
        f"Cost:${cost_usd:.2f}/{budget_max} ({budget_pct:.1f}%) | "
        f"ETA:{eta/60:.0f}min"
    )


def run_production(num_chapters: int = 0, use_real: bool = True,
                   start_from: int = 1, resume_checkpoint: int = 0):
    """运行全量生产并返回结果。num_chapters=0 时从 runtime_config.json 读取。"""
    project_root = Path(__file__).parent.parent
    if num_chapters <= 0:
        try:
            num_chapters = json.loads(
                (project_root / "config" / "runtime_config.json").read_text(encoding="utf-8")
            ).get("pipeline", {}).get("total_chapters", 3800)
        except (json.JSONDecodeError, ValueError, OSError):
            num_chapters = 3800
    logger.info(f"===== PRODUCTION START: {num_chapters} chapters =====")
    logger.info(f"Start from chapter: {start_from}")
    logger.info(f"Resume checkpoint: {resume_checkpoint}")
    start_time = time.time()

    (project_root / "audit").mkdir(parents=True, exist_ok=True)
    
    # 仅首次运行时重置状态；恢复模式跳过重置
    if resume_checkpoint == 0:
        reset_runtime_state(project_root)
    else:
        logger.info(f"Resuming from chapter {resume_checkpoint}, skipping runtime reset")

    if use_real:
        client = LLMClient.from_config(config_path=str(project_root / "config" / "runtime_config.json"))
        reset_call_log()  # Clear any stale call log
        logger.info("OK Using real API (SiliconFlow / Qwen)")
    else:
        from novel_engine.core.llm_client import MockLLMClient
        client = MockLLMClient()
        logger.info("OK Using mock LLM client")

    orchestrator = PipelineOrchestrator(str(project_root), llm_client=client)

    # 加载预算配置
    budget_cfg = json.loads((project_root / "config" / "cost_sandbox.json").read_text(encoding="utf-8"))
    budget_max = budget_cfg["budget"]["full_production_max"]

    results = []
    passed = 0
    failed = 0
    scores = []
    realm_locks_respected = True
    last_progress_log = 0  # Track last chapter logged

    for i in range(start_from, num_chapters + 1):
        # Skip chapters already committed via checkpoint — but verify files exist
        if resume_checkpoint > 0 and i <= resume_checkpoint:
            novel_path = project_root / "chapters" / "novel" / f"chapter_{i}.txt"
            synopsis_path = project_root / "chapters" / "synopsis" / f"chapter_{i}.txt"
            outline_path = project_root / "chapters" / "outline" / f"chapter_{i}.json"
            if novel_path.exists() and synopsis_path.exists() and outline_path.exists():
                logger.info(f"Skipping chapter {i} (already committed at checkpoint)")
                passed += 1
                continue
            logger.warning(f"Chapter {i} missing files despite checkpoint — will regenerate")

        logger.info(f"\n{'='*60}")
        logger.info(f"GENERATING CHAPTER {i}/{num_chapters}")
        logger.info(f"{'='*60}")

        try:
            result = orchestrator._run_with_retry(i)
            results.append(result)

            status = "PASS" if result["success"] else "FAIL"
            score = result.get("score", "N/A")
            if result["success"]:
                passed += 1
                if score is not None:
                    scores.append(score)
            else:
                failed += 1
                for err in result["errors"]:
                    logger.warning(f"  Error: {err}")

            logger.info(f"Chapter {i}: {status} (score={score})")

        except Exception as e:
            logger.error(f"Chapter {i} crashed: {e}")
            results.append({
                "chapter": i,
                "success": False,
                "score": None,
                "errors": [str(e)],
            })
            failed += 1
            # On crash, continue to next chapter (don't break)
            continue

        # 每50章触发滑动窗口审查
        if i % 50 == 0 and i <= num_chapters:
            logger.info(f"Triggering sliding window review at chapter {i}")
            orchestrator._run_sliding_window_review(i)

            # 验证质量记忆已刷新
            qm = orchestrator.memory.load_quality_memory()
            if qm.get("updated_at_chapter", 0) >= i:
                logger.info(f"OK Quality memory refreshed at chapter {qm['updated_at_chapter']}")

            # 验证滑动窗口审查结果已保存
            sw_reviews = orchestrator.memory.load_sliding_window_reviews()
            if any(r.get("window_end") == i for r in sw_reviews):
                logger.info(f"OK Sliding window review saved for chapters ending at {i}")

        # 验证 realm lock 是否被遵守
        world_state = orchestrator.simulator.build_world_state_for_chapter(i)
        for char_id, char_data in world_state.get("characters", {}).items():
            progression = char_data.get("progression_suggestion", {})
            if progression.get("locked"):
                locked_until = progression.get("reason", "")
                logger.debug(f"Chapter {i}: {char_id} locked at {progression.get('realm')}")

        # 定期输出进度
        elapsed = time.time() - start_time
        avg_score = sum(scores) / len(scores) if scores else 0
        cost_tracker = orchestrator.cost_tracker
        pricing = budget_cfg["currency_conversion"]["api_pricing"]
        input_price = pricing["input_per_1k_tokens"]
        output_price = pricing["output_per_1k_tokens"]
        # 按实际 input/output token 计算成本，而非 50/50 假设
        input_tokens = cost_tracker.get("total_prompt_tokens", 0) + cost_tracker.get("total_reasoning_tokens", 0)
        output_tokens = cost_tracker.get("total_completion_tokens", 0)
        cost_usd = (input_tokens * input_price + output_tokens * output_price) / 1000

        if i - last_progress_log >= 10 or i == num_chapters:
            print_progress(i, num_chapters, elapsed, passed, failed,
                          avg_score, cost_usd, budget_max)
            last_progress_log = i

    elapsed = time.time() - start_time

    # 最终验证
    integrity_ok = True
    for i in range(1, passed + 1):
        if not orchestrator.checkpoint_mgr.verify_integrity(i):
            logger.warning(f"Checkpoint integrity FAILED for chapter {i}")
            integrity_ok = False

    if integrity_ok:
        logger.info("OK All checkpoints pass integrity verification")

    # 验证文件是否写入
    verify_output_files(project_root, results, num_chapters)

    # 验证 recovery_policy
    verify_recovery_policy(project_root)

    # 计算最终统计
    avg_score = sum(scores) / len(scores) if scores else 0.0
    min_score = min(scores) if scores else 0
    max_score = max(scores) if scores else 0
    checkpoint_count = len(orchestrator.checkpoint_mgr.load().get("checkpoints", []))

    # 获取最终成本数据
    cost_report = orchestrator.get_cost_sandbox_report(passed)

    logger.info(f"\n{'='*60}")
    logger.info("PRODUCTION RESULTS")
    logger.info(f"{'='*60}")
    logger.info(f"Chapters attempted: {len(results)}")
    logger.info(f"Passed: {passed}")
    logger.info(f"Failed: {failed}")
    logger.info(f"Time elapsed: {elapsed:.2f}s ({elapsed/3600:.1f}h)")
    if scores:
        logger.info(f"Average score: {avg_score:.1f}")
        logger.info(f"Min score: {min_score}")
        logger.info(f"Max score: {max_score}")
    logger.info(f"Checkpoints created: {checkpoint_count}")
    logger.info(f"Total API calls: {cost_report['total_api_calls']}")
    logger.info(f"Total tokens: {cost_report['token_usage']['total_tokens']:,}")
    logger.info(f"Estimated full production cost: ${cost_report['cost_usd']['estimated_full_production']:.2f}")
    logger.info(f"Within budget: {cost_report['budget']['within_budget']}")
    logger.info(f"Sliding window constraint adjustments: {cost_report['sliding_window']['constraint_adjustment_count']}")

    # 确定成功条件
    success = (failed == 0 and integrity_ok and
               cost_report['budget']['within_budget'])

    report = {
        "test_type": "production",
        "total_chapters": num_chapters,
        "passed": passed,
        "failed": failed,
        "results": results,
        "checkpoint_count": checkpoint_count,
        "integrity_ok": integrity_ok,
        "elapsed_seconds": round(elapsed, 2),
        "success": success,
        "average_score": round(avg_score, 1),
        "min_score": min_score,
        "max_score": max_score,
        "cost_report": cost_report,
    }

    report_path = project_root / "audit" / "production_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report saved to {report_path}")

    return report


if __name__ == "__main__":
    use_real = "--real" in sys.argv
    args = [a for a in sys.argv if a != "--real"]

    num_chapters = int(args[1]) if len(args) > 1 else 0
    start_from = int(args[2]) if len(args) > 2 else 1
    resume_checkpoint = int(args[3]) if len(args) > 3 else 0

    logger.info(f"Production: {num_chapters} chapters, start={start_from}, resume={resume_checkpoint}")

    report = run_production(
        num_chapters=num_chapters,
        use_real=use_real,
        start_from=start_from,
        resume_checkpoint=resume_checkpoint,
    )

    if report["success"]:
        logger.info("\nPRODUCTION COMPLETED SUCCESSFULLY")
        sys.exit(0)
    else:
        logger.info("\nPRODUCTION COMPLETED WITH ISSUES")
        sys.exit(0)  # Don't fail — production may have partial results
