"""Shared KiCad reader conformance fixture (same files as CopperScript's)."""
import hashlib
import json
import math
from pathlib import Path
import unittest

from copper_review.importer import import_pcb, rotate

FIXTURE = Path(__file__).parent / "fixtures" / "kicad-conformance"


class ConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.expected = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))
        data = (FIXTURE / cls.expected["board"]).read_bytes()
        cls.data_sha = hashlib.sha256(data).hexdigest()
        cls.scene = import_pcb(data, cls.expected["board"])
        cls.tol = cls.expected["tolerance_mm"]

    def close(self, a, b):
        self.assertEqual(len(a), len(b))
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y, delta=self.tol)

    def test_fixture_is_the_shared_copy(self):
        self.assertEqual(self.data_sha, self.expected["board_sha256"])

    def test_footprints_and_pads(self):
        components = self.scene["components"]
        self.assertEqual(len(components), len(self.expected["footprints"]))
        self.assertEqual(len({c["reference"] for c in components}), len(components))
        for c, e in zip(components, self.expected["footprints"]):
            with self.subTest(footprint=c["reference"]):
                self.assertEqual(c.get("native_reference", c["reference"]), e["native_reference"])
                self.close(c["position_mm"], e["position_mm"])
                self.assertEqual(c["rotation_deg"], e["rotation_deg"])
                self.assertEqual(c["side"], e["side"])
                self.assertEqual([p["number"] for p in c["pads"]], [p["number"] for p in e["pads"]])
                for p, ep in zip(c["pads"], e["pads"]):
                    self.close(p["position_mm"], ep["center_mm"])
                    self.assertEqual(p["rotation_deg"], ep["rotation_deg"])
                    self.assertEqual(p["layers"], ep["layers"])
                    if "corners_mm" in ep:
                        w, h = p["size_mm"]
                        corners = [rotate(q, p["rotation_deg"], p["position_mm"])
                                   for q in [(-w/2, -h/2), (w/2, -h/2), (w/2, h/2), (-w/2, h/2)]]
                        for got, want in zip(corners, ep["corners_mm"]):
                            self.close(got, want)

    def test_zones_use_board_coordinates(self):
        kinds = {"outline": "intent", "fill": "fill", "keepout": "keepout"}
        owners = [c["source_path"] for c in self.scene["components"]]
        self.assertEqual(len(self.scene["zones"]), len(self.expected["zones"]))
        for e in self.expected["zones"]:
            owner = owners[e["footprint_index"]] if e["footprint_index"] is not None else None
            match = [z for z in self.scene["zones"] if z["kind"] == kinds[e["kind"]] and z.get("owner") == owner
                     and e["layer"] in z["layers"] and z["net"] == e["net"]]
            self.assertEqual(len(match), 1, e)
            for got, want in zip(match[0]["points_mm"], e["points_mm"]):
                self.close(got, want)

    def test_arcs_and_vias(self):
        for e in self.expected["arcs"]:
            arc = next(t for t in self.scene["tracks"] if "arc" in t)
            points = arc["points_mm"]
            self.close(points[0], e["start_mm"]); self.close(points[-1], e["end_mm"])
            for p in points:
                self.assertAlmostEqual(math.dist(p, e["center_mm"]), e["radius_mm"], delta=1e-6)
            self.assertTrue(all(p[0] >= e["start_mm"][0] - 1e-9 and p[1] <= e["end_mm"][1] + 1e-9 for p in points))
        for e in self.expected["vias"]:
            via = next(v for v in self.scene["vias"] if v["net"] == e["net"])
            self.close(via["position_mm"], e["position_mm"])
            self.assertEqual(via["layers"], e["layers"])


if __name__ == "__main__":
    unittest.main()
