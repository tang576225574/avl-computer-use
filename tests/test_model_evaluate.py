import unittest
from model.evaluate import load_dataset, score

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
