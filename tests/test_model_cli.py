"""Exercise the avl-model entry point without loading weights or starting a listener."""
import argparse
from contextlib import redirect_stderr, redirect_stdout
from importlib.util import find_spec
from io import StringIO
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from model.adapter import main
from model.engine import parse_engine_args


class EngineCreated(Exception):
    pass


class ModelCliTests(unittest.TestCase):
    def setUp(self):
        def add_args(parser):
            parser.add_argument("--model")
            parser.add_argument("--gpu-memory-utilization", type=float)
            parser.add_argument("--tensor-parallel-size", type=int)
            parser.add_argument("--max-model-len", type=int)
            parser.add_argument("--enforce-eager", action="store_true")
            return parser

        self.native_args = Mock()
        self.native_args.add_cli_args.side_effect = add_args
        self.native_args.from_cli_args.side_effect = lambda args: args
        self.start = Mock(side_effect=EngineCreated)
        modules = {
            "vllm.utils.argparse_utils": SimpleNamespace(FlexibleArgumentParser=argparse.ArgumentParser),
            "vllm.engine.arg_utils": SimpleNamespace(AsyncEngineArgs=self.native_args),
            "vllm.renderers.params": SimpleNamespace(ChatParams=Mock()),
            "vllm.sampling_params": SimpleNamespace(SamplingParams=Mock(), RequestOutputKind=Mock()),
            "vllm.v1.engine.async_llm": SimpleNamespace(AsyncLLM=SimpleNamespace(from_engine_args=self.start)),
            "vllm.v1.engine.exceptions": SimpleNamespace(EngineDeadError=RuntimeError),
        }
        self.enterContext(patch.dict(sys.modules, modules))
        self.enterContext(patch.dict(os.environ, AVL_MODEL_TOKENS='["test-only"]', AVL_OMNI_MODEL="env-model"))
        self.enterContext(patch("model.adapter.logging.basicConfig"))

    def test_cli_passes_native_types_and_selected_model_to_shared_engine(self):
        for prefix, suffix, model in [
            ([], [], "env-model"),
            (["--model", "wrapper model"], [], "wrapper model"),
            (["--model", "wrapper model"], ["--model", "/models/new model"], "/models/new model"),
        ]:
            with self.subTest(model=model), patch.dict(os.environ, AVL_MODEL_TOKENS='["test-only"]'):
                with self.assertRaises(EngineCreated):
                    main([*prefix, "--max-concurrency", "3", "--", "--gpu-memory-utilization=0.8",
                          "--tensor-parallel-size", "2", "--max-model-len", "16384", "--enforce-eager", *suffix])
                args, = self.start.call_args.args
                self.assertEqual(vars(args), dict(model=model, gpu_memory_utilization=0.8,
                                                  tensor_parallel_size=2, max_model_len=16384, enforce_eager=True))

    def test_native_help_exits_without_credentials_or_engine(self):
        os.environ.pop("AVL_MODEL_TOKENS")
        with redirect_stdout(StringIO()) as out, self.assertRaises(SystemExit) as stopped:
            main(["--", "--help"])
        self.assertEqual(stopped.exception.code, 0)
        self.assertIn("--gpu-memory-utilization", out.getvalue())
        self.start.assert_not_called()

    def test_rejects_wrong_side_and_malformed_engine_flags(self):
        for args, expected in [
            (["--gpu-memory-utilization", "0.8"], "unrecognized arguments"),
            (["--", "--port", "1234"], "unrecognized arguments"),
            (["--", "--gpu-memory-utilization", "oops"], "invalid float value"),
            (["--benchmark", "--", "--enforce-eager"], "--benchmark cannot be combined"),
        ]:
            with self.subTest(args=args):
                with redirect_stderr(StringIO()) as err, self.assertRaises(SystemExit) as stopped:
                    main(args)
                self.assertEqual(stopped.exception.code, 2)
                self.assertIn(expected, err.getvalue())
        self.start.assert_not_called()


@unittest.skipUnless(find_spec("vllm"), "requires the project's gpu extra")
class InstalledParserTests(unittest.TestCase):
    def test_native_parser_without_starting_workers(self):
        args = parse_engine_args("/models/desktop", ["--gpu-memory-utilization=0.8", "-tp", "2",
                                                    "--max-model-len", "16K", "--enforce-eager"])
        self.assertEqual(args.model, "/models/desktop")
        self.assertEqual(args.gpu_memory_utilization, 0.8)
        self.assertEqual(args.tensor_parallel_size, 2)
        self.assertEqual(args.max_model_len, 16384)
        self.assertTrue(args.enforce_eager)
