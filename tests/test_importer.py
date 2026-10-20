import hashlib
from pathlib import Path
import unittest

from copper_review.importer import import_pcb, parse, arc_points, rotate

ROOT = Path(__file__).resolve().parents[1]
DEMO = (ROOT / "examples/demo.kicad_pcb").read_bytes()


class ImportTests(unittest.TestCase):
    def test_actual_demo_identity_and_copper(self):
        scene = import_pcb(DEMO, "demo.kicad_pcb", stage="partially_routed")
        self.assertEqual(scene["board"]["sha256"], hashlib.sha256(DEMO).hexdigest())
        self.assertEqual(scene["board"]["bounds_mm"], [0.0, 0.0, 50.0, 35.0])
        self.assertEqual(len(scene["components"]), 4)
        self.assertEqual(len(scene["tracks"]), 7)
        self.assertEqual(scene["components"][0]["source_path"], "control.U1")
        self.assertEqual({z["kind"] for z in scene["zones"]}, {"fill", "intent"})
        self.assertEqual(scene["vias"][0]["net"], "GND")
        self.assertEqual(len(next(n for n in scene["nets"] if n["name"] == "+3V3")["pads"]), 4)

    def test_rotated_pad_positions_and_absolute_angles(self):
        scene = import_pcb(DEMO, "demo.kicad_pcb")
        cap = next(c for c in scene["components"] if c["reference"] == "C1")
        self.assertEqual(cap["pads"][0]["position_mm"], [13.0, 14.0])
        self.assertEqual(cap["pads"][0]["rotation_deg"], 90)
        self.assertEqual(cap["pads"][1]["position_mm"], [13.0, 12.0])

    def test_back_footprint_uses_file_reflection_once(self):
        data = b'''(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
          (net 1 "hierarchical.GND")
          (footprint "X" (layer "B.Cu") (at 10 20 90)
            (property "Reference" "B1") (property "CopperScriptPath" "power.input.B1")
            (pad "A" smd rect (at 2 -3 45) (size 1 2) (layers "B.Cu") (net 1 "hierarchical.GND"))))'''
        scene = import_pcb(data, "back.kicad_pcb")
        c = scene["components"][0]
        self.assertEqual(c["side"], "back")
        self.assertEqual(c["pads"][0]["position_mm"], [7, 18])
        self.assertEqual(c["pads"][0]["rotation_deg"], 45)
        self.assertEqual(c["source_path"], "power.input.B1")

    def test_through_hole_layers_and_blind_via_span(self):
        data = b'''(kicad_pcb (layers (0 "F.Cu" signal) (2 "In1.Cu" power) (4 "In2.Cu" power) (31 "B.Cu" signal))
          (via blind (at 1 2) (size .6) (drill .3) (layers "F.Cu" "In2.Cu") (net 0)))'''
        scene = import_pcb(data, "blind.kicad_pcb")
        self.assertEqual(scene["vias"][0]["layers"], ["F.Cu", "In1.Cu", "In2.Cu"])
        demo = import_pcb(DEMO, "demo.kicad_pcb")
        j = next(c for c in demo["components"] if c["reference"] == "J1")
        self.assertEqual(j["pads"][0]["layers"], ["F.Cu", "B.Cu"])

    def test_arc_direction_and_error_bound(self):
        points = arc_points([1, 0], [0, 1], [-1, 0])
        self.assertEqual(points[0], [1, 0]); self.assertEqual(points[-1], [-1, 0])
        self.assertTrue(all(p[1] >= -1e-9 for p in points))
        for a,b in zip(points,points[1:]):
            mid = [(a[0]+b[0])/2,(a[1]+b[1])/2]
            self.assertLessEqual(1-(mid[0]**2+mid[1]**2)**.5, .0100001)
        major = arc_points([1,0],[-1,0],[0,1])
        self.assertTrue(any(p[1] < -.9 for p in major))

    def test_names_and_invalid_input(self):
        self.assertEqual(parse('(root "a \\"quoted\\" name" "path\\\\file")'), ['root', 'a "quoted" name', 'path\\file'])
        for text in ['(bad', '()', '(root))', '(a)(b)', '"unterminated', '(' * 257 + ')' * 257]:
            with self.subTest(text=text[:30]), self.assertRaises(ValueError):
                import_pcb(text.encode(), "bad")
        with self.assertRaises(ValueError):
            import_pcb(b'(kicad_pcb (gr_line (start nan 0) (end 1 1)))', 'bad')

    def test_stage_never_inferred_from_track_count(self):
        scene = import_pcb(DEMO, "demo.kicad_pcb")
        self.assertEqual(scene["board"]["stage"], "unknown")
        self.assertIn("not connectivity validation", scene["board"]["stage_evidence"])

    def test_netted_graphic_copper_and_rotated_footprint_keepout(self):
        data = b'''(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "GND")
          (gr_poly (pts (xy 1 1) (xy 2 1) (xy 2 2)) (stroke (width 0) (type default))
            (fill yes) (layer "F.Cu") (net 1) (uuid "polygon-id"))
          (footprint "Test" (layer "B.Cu") (at 10 20 90) (property "Reference" "U1")
            (property "CopperScriptPath" "radio.U1")
            (zone (layer "B.Cu") (keepout (tracks not_allowed))
              (polygon (pts (xy 10 20) (xy 10 18) (xy 13 18))))))'''
        scene = import_pcb(data, "test.kicad_pcb")
        copper = next(z for z in scene["zones"] if z["kind"] == "copper")
        self.assertEqual(copper["net"], "GND")
        keepout = next(z for z in scene["zones"] if z["kind"] == "keepout")
        self.assertEqual(keepout["owner"], "radio.U1")
        # KiCad stores footprint zone outlines in board coordinates: no pose is applied.
        self.assertEqual(keepout["points_mm"], [[10,20],[10,18],[13,18]])

    def test_pad_without_angle_is_absolute_zero_and_empty_zones_are_skipped(self):
        data = b'''(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
          (footprint "R" (layer "F.Cu") (at 10 10 90) (property "Reference" "R1")
            (pad "1" smd rect (at -1 0) (size 1 0.5) (layers "F.Cu"))
            (pad "2" smd rect (at 1 0 90) (size 1 0.5) (layers "F.Cu"))
            (zone (layer "F.Cu") (keepout (tracks not_allowed))))
          (zone (net 0) (net_name "") (layer "F.Cu") (polygon (pts (xy 0 0) (xy 1 0)))))'''
        scene = import_pcb(data, "angles.kicad_pcb")
        pads = scene["components"][0]["pads"]
        self.assertEqual([p["rotation_deg"] for p in pads], [0, 90])
        self.assertEqual(pads[0]["position_mm"], [10, 11])
        self.assertEqual(scene["zones"], [])
        self.assertIn("Zones with fewer than three outline points are skipped.", scene["warnings"])

    def test_pin_names_are_kept_for_labels_and_net_feedback(self):
        data = b'''(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "I2C_SCL")
          (footprint "Sensor" (layer "F.Cu") (at 10 20) (property "Reference" "U1")
            (pad "3" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 1 "I2C_SCL") (pinfunction "SCL"))))'''
        scene = import_pcb(data, "sensor.kicad_pcb")
        self.assertEqual(scene["components"][0]["pads"][0]["pin_name"], "SCL")
        self.assertEqual(scene["nets"][0]["pads"][0]["pin_name"], "SCL")

    def test_blank_and_repeated_references_are_disambiguated(self):
        data = b'''(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
          (footprint "" (layer "F.Cu") (at 1 1) (property "Reference" ""))
          (footprint "Fiducial:FID" (layer "F.Cu") (at 2 2) (property "Reference" ""))
          (footprint "R" (layer "F.Cu") (at 3 3) (property "Reference" "R1"))
          (footprint "R" (layer "F.Cu") (at 4 4) (property "Reference" "R1"))
          (footprint "R" (layer "F.Cu") (at 5 5) (property "Reference" "R1#2")))'''
        scene = import_pcb(data, "refs.kicad_pcb")
        refs = [c["reference"] for c in scene["components"]]
        self.assertEqual(refs, ["FP#1", "FID#1", "R1", "R1#3", "R1#2"])
        self.assertEqual([c.get("native_reference") for c in scene["components"]], ["", "", None, "R1", None])
        self.assertTrue(any("blank or repeated reference" in w for w in scene["warnings"]))
        legacy = import_pcb(b'(kicad_pcb (layers (0 "F.Cu" signal)) (footprint "X" (layer "F.Cu") (at 0 0)) (footprint "Y" (layer "F.Cu") (at 1 1)))', "x")
        self.assertEqual([c["reference"] for c in legacy["components"]], ["FP1", "FP2"])
        self.assertTrue(all("native_reference" not in c for c in legacy["components"]))

    def test_example_scene_is_what_the_importer_produces(self):
        import json
        expected = json.loads((ROOT / "examples/demo.scene.json").read_text(encoding="utf-8"))
        self.assertEqual(import_pcb(DEMO, "demo.kicad_pcb", stage="partially_routed"), expected)

    def test_example_review_matches_the_published_schema(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema is not installed")
        import json
        schema = json.loads((ROOT / "docs/review.schema.json").read_text(encoding="utf-8"))
        review = json.loads((ROOT / "examples/demo.review.json").read_text(encoding="utf-8"))
        jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(review)
        self.assertEqual(review["board"]["sha256"], hashlib.sha256(DEMO).hexdigest())


if __name__ == "__main__":
    unittest.main()
