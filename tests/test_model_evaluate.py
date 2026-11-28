import unittest
from unittest.mock import AsyncMock, patch

from model.evaluate import load_dataset, predict, score

class EvaluationTests(unittest.TestCase):
    def test_missing_and_edge_predictions_count_as_misses(self):
        cases = [dict(id="hit",size=[1000,1000],box=[0,0,100,100]),dict(id="miss",size=[1000,1000],box=[0,0,100,100]),dict(id="missing",size=[1000,1000],box=[0,0,100,100])]
        result=score(cases, {"hit":[0,0], "miss":[100,50]})
        self.assertEqual((result["hits"],result["total"],result["missing"]),(1,3,1))
        self.assertAlmostEqual(result["hitRate"],1/3)

    def test_pixel_conversion_matches_host_rounding(self):
        cases=[dict(id="edge",size=[512,256],box=[1,1,2,2])]
        self.assertEqual(score(cases,{"edge":[1,2]})["hits"],1)

    def test_fractional_points_are_not_actionable(self):
        cases=[dict(id="button",size=[512,256],box=[0,0,512,256])]
        self.assertEqual(score(cases,{"button":[501.3,250]})["hits"],0)

    def test_fixtures_have_real_jpegs_and_known_boxes(self):
        cases=load_dataset()
        self.assertGreaterEqual(len(cases),6)
        for case in cases:
            self.assertTrue(case["path"].read_bytes().startswith(b"\xff\xd8"))
            x,y,right,bottom=case["box"]
            self.assertTrue(0<=x<right<=case["size"][0] and 0<=y<bottom<=case["size"][1])

class EmbeddedEvaluationTests(unittest.IsolatedAsyncioTestCase):
    async def test_evaluation_reuses_and_closes_one_local_engine(self):
        model = AsyncMock()
        model.decide.side_effect = [
            ("button", {"kind": "click", "x": 120, "y": 250}),
            ("menu", None),
        ]
        cases = load_dataset()[:2]
        with patch("model.evaluate.EmbeddedOmni.create", return_value=model) as create:
            predictions = await predict(cases, "local-weights")
        self.assertEqual(predictions, {cases[0]["id"]: [120, 250]})
        create.assert_awaited_once_with("local-weights")
        self.assertEqual(model.decide.await_count, 2)
        model.close.assert_awaited_once()

    async def test_engine_failure_closes_before_propagating(self):
        model = AsyncMock()
        model.decide.side_effect = RuntimeError("engine offline")
        with patch("model.evaluate.EmbeddedOmni.create", return_value=model):
            with self.assertRaisesRegex(RuntimeError, "engine offline"):
                await predict(load_dataset(), "local-weights")
        model.close.assert_awaited_once()
