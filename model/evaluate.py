"""Measure click localization against explicitly annotated desktop controls."""
import argparse
import asyncio
import json
import math
import os
import sys
from pathlib import Path

from .engine import DEFAULT_MODEL, EmbeddedOmni


DATASET = Path(__file__).parent / "fixtures" / "controls.json"


def load_dataset(filename=DATASET):
    filename = Path(filename)
    cases = json.loads(filename.read_text(encoding="utf-8"))
    ids = set()
    if not isinstance(cases, list) or not cases:
        raise ValueError("dataset must contain examples")
    for case in cases:
        x, y, r, b = case["box"]
        w, h = case["size"]
        if case["id"] in ids or not (0 <= x < r <= w and 0 <= y < b <= h):
            raise ValueError("duplicate id or invalid target box")
        ids.add(case["id"])
        case["path"] = filename.parent / case["image"]
    return cases


def score(cases, predictions):
    ids = {case["id"] for case in cases}
    if set(predictions) - ids:
        raise ValueError("prediction names an unknown example")
    hits = missing = 0
    outcomes = []
    for case in cases:
        point = predictions.get(case["id"])
        valid = (isinstance(point, (tuple, list)) and len(point) == 2
                 and all(type(n) in (int, float) and 0 <= n <= 1000 and n == int(n) for n in point))
        hit = False
        if valid:
            w, h = case["size"]
            # Map the normalized endpoint 1000 to the last pixel, as on the Host.
            x = math.floor(point[0] * (w - 1) / 1000 + 0.5)
            y = math.floor(point[1] * (h - 1) / 1000 + 0.5)
            left, top, right, bottom = case["box"]
            hit = left <= x < right and top <= y < bottom
        else:
            missing += 1
        hits += int(hit)
        outcomes.append({"id":case["id"], "hit":hit, "point":point})
    return dict(hits=hits, total=len(cases), missing=missing, hitRate=hits / len(cases), examples=outcomes)


async def predict(cases, name):
    predictions = {}
    model = await EmbeddedOmni.create(name)
    try:
        for case in cases:
            try:
                _, action = await model.decide(case["path"].read_bytes(), case["instruction"], False)
                if isinstance(action, dict) and action.get("kind") == "click":
                    predictions[case["id"]] = [action.get("x"), action.get("y")]
            except (ValueError, TypeError, IndexError, KeyError, OSError) as error:
                print(f"{case['id']}: {type(error).__name__}", file=sys.stderr)
    finally:
        await model.close()
    return predictions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DATASET)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--predictions", type=Path, help='offline JSON object mapping case IDs to [x,y] in 0–1000')
    source.add_argument("--omni", action="store_true", help="run localized click predictions with the local GPU engine")
    parser.add_argument("--model", default=os.getenv("AVL_OMNI_MODEL", DEFAULT_MODEL), help="local inference model ID or path")
    args = parser.parse_args()
    cases = load_dataset(args.dataset)
    if args.omni:
        predictions = asyncio.run(predict(cases, args.model))
    else:
        predictions = json.loads(args.predictions.read_text(encoding="utf-8"))
        if not isinstance(predictions, dict):
            parser.error("predictions must be a JSON object")
    print(json.dumps(score(cases, predictions), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
