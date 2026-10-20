"""Read exported PCB geometry without KiCad or CopperScript installed.

KiCad footprint coordinates already encode back-side reflection. Its positive
angles are counterclockwise in a world with y pointing down; pad angles are
absolute (an omitted angle is 0, not the footprint angle), while pad and graphic
positions are footprint-local. Zones inside a footprint are stored in absolute
board coordinates, like board-level zones.
"""
from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path

SCENE_SCHEMA = "copper-review-scene/v1"
COORDINATES = {"units": "mm", "origin": "native PCB file origin", "x_axis": "right",
               "y_axis": "down", "view": "front (back layers are not mirrored)",
               "positive_rotation": "counterclockwise"}
STAGES = ("unknown", "placed", "partially_routed", "fully_routed")
TOKEN = re.compile(r'\s*(\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+)')


def parse(text: str) -> list:
    """Bounded, iterative s-expression parser preserving names and escapes."""
    stack, roots, pos = [], [], 0
    for match in TOKEN.finditer(text):
        if text[pos:match.start()].strip():
            raise ValueError("Invalid PCB syntax")
        pos = match.end()
        token = match[1]
        if token == "(":
            node = []
            (stack[-1] if stack else roots).append(node)
            stack.append(node)
            if len(stack) > 256:
                raise ValueError("PCB nesting exceeds 256 levels")
        elif token == ")":
            if not stack:
                raise ValueError("Unexpected closing parenthesis")
            stack.pop()
        else:
            if not stack:
                raise ValueError("Expected a PCB expression")
            if token.startswith('"'):
                token = re.sub(r'\\(.)', lambda m: {"n": "\n", "r": "\r", "t": "\t"}.get(m[1], m[1]), token[1:-1])
            stack[-1].append(token)
    if stack or text[pos:].strip() or len(roots) != 1:
        raise ValueError("Unclosed or invalid PCB expression")
    return roots[0]


def children(node, name):
    return [x for x in node if isinstance(x, list) and x and x[0] == name]


def first(node, name, default=None):
    return next(iter(children(node, name)), default)


def number(v):
    result = float(v)
    if not math.isfinite(result) or abs(result) > 1e8:
        raise ValueError("Non-finite or out-of-range geometry")
    return result


def xy(node, name):
    item = first(node, name)
    if not item or len(item) < 3:
        raise ValueError(f"Missing {name} coordinates")
    return [number(item[1]), number(item[2])]


def rotate(point, angle, origin=(0, 0)):
    angle = math.radians(angle)
    c, s = math.cos(angle), math.sin(angle)
    return [round(origin[0] + point[0]*c + point[1]*s, 9),
            round(origin[1] - point[0]*s + point[1]*c, 9)]


def arc_points(start, mid, end):
    """Sample a circular arc to <=0.01 mm chord error, preserving endpoints."""
    ax, ay = start; bx, by = mid; cx, cy = end
    d = 2*(ax*(by-cy) + bx*(cy-ay) + cx*(ay-by))
    if abs(d) < 1e-12:
        return [start, mid, end]
    aa, bb, cc = ax*ax+ay*ay, bx*bx+by*by, cx*cx+cy*cy
    ux = (aa*(by-cy)+bb*(cy-ay)+cc*(ay-by))/d
    uy = (aa*(cx-bx)+bb*(ax-cx)+cc*(bx-ax))/d
    angles = [math.atan2(y-uy, x-ux) for x, y in (start, mid, end)]
    tau = math.tau
    sweep = (angles[2]-angles[0]) % tau
    if (angles[1]-angles[0]) % tau > sweep:
        sweep -= tau
    r = math.hypot(ax-ux, ay-uy)
    step = min(math.pi/16, 2*math.acos(max(-1, 1-0.01/r))) if r > 0.01 else math.pi/16
    count = max(2, math.ceil(abs(sweep)/max(step, 1e-6)))
    if count > 20000:
        raise ValueError("Arc geometry too large to sample")
    return [start] + [[ux+r*math.cos(angles[0]+sweep*i/count), uy+r*math.sin(angles[0]+sweep*i/count)]
                      for i in range(1, count)] + [end]


def graphic(node, transform=lambda p: p):
    kind = node[0].split("_", 1)[1]
    stroke = first(node, "stroke", [])
    width = number(first(stroke, "width", first(node, "width", ["width", "0.1"]))[1])
    layer = first(node, "layer", ["layer", "F.SilkS"])[1]
    filled = first(node, "fill", ["fill", "none"])[1] in {"solid", "yes"}
    points = []
    if kind == "line":
        points = [xy(node, "start"), xy(node, "end")]
    elif kind == "rect":
        a, b = xy(node, "start"), xy(node, "end")
        points = [a, [b[0], a[1]], b, [a[0], b[1]], a]
    elif kind == "poly":
        points = [xy([p], "xy") for p in children(first(node, "pts", []), "xy")]
        if points:
            points.append(points[0])
    elif kind == "arc":
        if first(node, "mid") is None:
            raise ValueError("Legacy arc syntax is unsupported; export a modern CopperScript PCB")
        points = arc_points(xy(node, "start"), xy(node, "mid"), xy(node, "end"))
    elif kind == "circle":
        center, end = xy(node, "center"), xy(node, "end")
        radius = math.dist(center, end)
        count = max(32, math.ceil(math.tau/max(1e-6, 2*math.acos(max(-1, 1-0.01/max(radius, .01))))))
        if count > 20000:
            raise ValueError("Circle geometry too large")
        points = [[center[0]+radius*math.cos(math.tau*i/count), center[1]+radius*math.sin(math.tau*i/count)] for i in range(count+1)]
    if not points:
        return None
    return {"points": [transform(p) for p in points], "layer": layer, "width_mm": width, "filled": filled}


def bounds(points, fallback=(0, 0, 40, 30)):
    if not points:
        return list(fallback)
    xs, ys = zip(*points)
    return [min(xs), min(ys), max(xs), max(ys)]


def import_pcb(data: bytes, filename: str, *, stage="unknown", source=None):
    if stage not in STAGES:
        raise ValueError("Invalid board stage")
    tree = parse(data.decode("utf-8-sig"))
    if not tree or tree[0] != "kicad_pcb":
        raise ValueError("Expected a .kicad_pcb file, not electrical-only board.json")
    layers = [x[1] for x in first(tree, "layers", [])[1:] if isinstance(x, list) and len(x) > 1 and x[1].endswith(".Cu")]
    layers = layers or ["F.Cu", "B.Cu"]
    net_codes = {n[1]: n[2] for n in children(tree, "net") if len(n) > 2}
    warnings = set()

    def net(item):
        n = first(item, "net")
        if n is None:
            return ""
        # New KiCad files may encode names directly rather than numeric IDs.
        if len(n) > 2:
            return n[2]
        return net_codes.get(n[1], n[1] if not n[1].isdigit() else "")

    def identity(item, fallback):
        return first(item, "uuid", first(item, "tstamp", ["uuid", fallback]))[1]

    components, tracks, vias, zones, drawings = [], [], [], [], []
    footprints = children(tree, "footprint") + children(tree, "module")
    native_refs = []
    for index, fp in enumerate(footprints):
        props = {p[1]: p[2] for p in children(fp, "property") if len(p) > 2}
        texts = {p[1]: p[2] for p in children(fp, "fp_text") if len(p) > 2}
        native_refs.append(props.get("Reference", texts.get("reference", "")))
    # Selections and net membership name components by reference, so references
    # must be unique. Blank (logos, fiducials) and repeated native references get
    # a stable "#n" suffix in file order; native_reference keeps the original.
    taken, counts, references = set(r for r in native_refs if r), {}, []
    for index, (fp, native) in enumerate(zip(footprints, native_refs)):
        if native and native not in counts:
            counts[native] = 1
            references.append(native)
            continue
        base = native or (fp[1].rsplit(":", 1)[-1] if len(fp) > 1 and isinstance(fp[1], str) and fp[1] else "FP")
        n = counts.get(base, 0)
        while True:
            n += 1
            candidate = f"{base}#{n}"
            if candidate not in taken:
                break
        counts[base] = n
        taken.add(candidate)
        references.append(candidate)
    renamed = sum(1 for a, b in zip(native_refs, references) if a != b)
    if renamed:
        warnings.add(f"{renamed} footprint(s) with a blank or repeated reference are named <reference or footprint>#n; "
                     "native_reference keeps the original text.")

    def read_zone(z, fallback_id, owner=None):
        zone_layers = first(z, "layers", first(z, "layer", ["layer", "F.Cu"]))[1:]
        zone_net = first(z, "net_name", ["net_name", net(z)])[1]
        is_keepout = first(z, "keepout") is not None
        for poly in children(z, "polygon") + children(z, "filled_polygon"):
            points = [xy([p], "xy") for p in children(first(poly, "pts", []), "xy")]
            if len(points) < 3:
                # KiCad keeps outline-less zones (e.g. rule areas being edited); nothing to draw or query.
                warnings.add("Zones with fewer than three outline points are skipped.")
                continue
            actual = poly[0] == "filled_polygon"
            poly_layer = first(poly, "layer", ["layer", zone_layers[0]])[1]
            zones.append({"id": identity(z, fallback_id)+f":{len(zones)}", "net": zone_net,
                          "points_mm": points, "layers": [poly_layer] if actual else zone_layers,
                          "kind": "keepout" if is_keepout else "fill" if actual else "intent",
                          **({"owner": owner} if owner else {})})
        if children(z, "filled_polygon"):
            warnings.add("Filled polygons are displayed as stored; fills are not recomputed or electrically verified.")
    for index, fp in enumerate(footprints):
        props = {p[1]: p[2] for p in children(fp, "property") if len(p) > 2}
        texts = {p[1]: p[2] for p in children(fp, "fp_text") if len(p) > 2}
        ref = references[index]
        origin = xy(fp, "at")
        at = first(fp, "at")
        angle = number(at[3]) if len(at) > 3 else 0
        transform = lambda p, a=angle, o=origin: rotate(p, a, o)
        component = {"id": identity(fp, f"component:{index}"), "reference": ref,
                     **({"native_reference": native_refs[index]} if native_refs[index] != ref else {}),
                     "source_path": props.get("CopperScriptPath", ref),
                     "value": props.get("Value", texts.get("value", "")), "footprint": fp[1],
                     "position_mm": origin, "rotation_deg": angle,
                     "side": "back" if first(fp, "layer", ["layer", "F.Cu"])[1].startswith("B.") else "front",
                     "locked": "locked" in fp or first(fp, "locked", ["locked", "no"])[-1] == "yes", "pads": [], "graphics": []}
        for pi, pad in enumerate(children(fp, "pad")):
            if len(pad) < 4:
                raise ValueError(f"Invalid pad on {ref}")
            if pad[3] not in {"rect", "roundrect", "circle", "oval"}:
                warnings.add(f"Unsupported pad shape {pad[3]} on {ref}: shown as a bounding rectangle.")
            pa = first(pad, "at", ["at", "0", "0"])
            size = xy(pad, "size")
            raw_layers = first(pad, "layers", ["layers"])[1:]
            pad_layers = layers[:] if "*.Cu" in raw_layers else [l for l in raw_layers if l.endswith(".Cu")]
            if pad[2] == "np_thru_hole":
                pad_layers = []
            drill = first(pad, "drill", ["drill"])[1:]
            drill = [number(v) for v in drill if isinstance(v, str) and v not in {"oval"}]
            if len(drill) == 1:
                drill *= 2
            component["pads"].append({"id": identity(pad, f"pad:{index}:{pi}"), "number": pad[1], "net": net(pad),
                "pin_name": first(pad, "pinfunction", ["pinfunction", ""])[1],
                "position_mm": transform([number(pa[1]), number(pa[2])]), "size_mm": size,
                "rotation_deg": number(pa[3]) if len(pa) > 3 else 0, "shape": pad[3], "kind": pad[2],
                "layers": pad_layers, "drill_mm": drill[:2],
                "roundrect_ratio": number(first(pad, "roundrect_rratio", ["ratio", "0.25"])[1])})
        for g in fp:
            if isinstance(g, list) and g and g[0] in {"fp_line", "fp_rect", "fp_poly", "fp_arc", "fp_circle"}:
                result = graphic(g, transform)
                if result:
                    component["graphics"].append(result)
        points = [p for g in component["graphics"] for p in g["points"]]
        for p in component["pads"]:
            w, h = p["size_mm"]
            points.extend(rotate(q, p["rotation_deg"], p["position_mm"]) for q in [(-w/2,-h/2),(w/2,-h/2),(w/2,h/2),(-w/2,h/2)])
        component["bounds_mm"] = bounds(points, (*origin, *origin))
        components.append(component)
        for zi, z in enumerate(children(fp, "zone")):
            read_zone(z, f"footprint-zone:{index}:{zi}", component["source_path"])
        if children(fp, "fp_curve"):
            warnings.add(f"Bezier footprint graphics on {ref} are not displayed.")
    for index, t in enumerate(children(tree, "segment") + children(tree, "arc")):
        points = [xy(t, "start"), xy(t, "end")]
        arc = None
        if t[0] == "arc":
            arc = {"start_mm": points[0], "mid_mm": xy(t, "mid"), "end_mm": points[1]}
            points = arc_points(points[0], arc["mid_mm"], points[1])
        tracks.append({"id": identity(t, f"track:{index}"), "net": net(t), "points_mm": points,
                       "width_mm": number(first(t, "width")[1]), "layer": first(t, "layer")[1],
                       **({"arc": arc} if arc else {})})
    for index, v in enumerate(children(tree, "via")):
        via_layers = first(v, "layers", ["layers", layers[0], layers[-1]])[1:]
        if len(via_layers) == 2 and all(l in layers for l in via_layers):
            a, b = sorted(layers.index(l) for l in via_layers)
            via_layers = layers[a:b+1]
        vias.append({"id": identity(v, f"via:{index}"), "net": net(v), "position_mm": xy(v, "at"),
                     "size_mm": number(first(v, "size")[1]), "drill_mm": number(first(v, "drill")[1]), "layers": via_layers})
    for index, z in enumerate(children(tree, "zone")):
        read_zone(z, f"zone:{index}")
    for g in tree:
        if isinstance(g, list) and g and g[0] in {"gr_line", "gr_rect", "gr_poly", "gr_arc", "gr_circle"}:
            result = graphic(g)
            if result:
                if result["layer"].endswith(".Cu") and net(g) and result["filled"]:
                    zones.append({"id": identity(g, f"copper-polygon:{len(zones)}"), "net": net(g),
                                  "points_mm": result["points"], "layers": [result["layer"]], "kind": "copper"})
                else:
                    drawings.append(result)
                    if result["layer"].endswith(".Cu"):
                        warnings.add("Graphic copper without a supported filled netted shape: select it through a region.")
    if children(tree, "gr_curve"):
        warnings.add("Bezier board graphics are not displayed.")
    if children(tree, "group"):
        warnings.add("KiCad groups are not imported; component source paths and object UUIDs are retained.")
    if any(c["pads"] and any(p["shape"] == "custom" for p in c["pads"]) for c in components):
        warnings.add("Custom-pad primitives are not interpreted.")
    edges = [p for g in drawings if g["layer"] == "Edge.Cuts" for p in g["points"]]
    all_points = edges or [p for c in components for p in [c["position_mm"], c["bounds_mm"][:2], c["bounds_mm"][2:]]]
    for t in tracks:
        if not edges:
            all_points.extend(t["points_mm"])
    board_bounds = bounds(all_points)
    if not edges:
        warnings.add("No Edge.Cuts geometry: viewport bounds are estimated from objects.")
    warnings.add("Curves are sampled to a maximum 0.01 mm chord error for display and region queries.")
    names = set(net_codes.values()) | {p["net"] for c in components for p in c["pads"]} | {t["net"] for t in tracks} | {v["net"] for v in vias} | {z["net"] for z in zones}
    nets = [{"name": name, "pads": [{"component": c["reference"], "source_path": c["source_path"],
             "number": p["number"], "pin_name": p["pin_name"], "id": p["id"], "position_mm": p["position_mm"], "layers": p["layers"]}
             for c in components for p in c["pads"] if p["net"] == name]} for name in sorted(names) if name]
    return {"schema": SCENE_SCHEMA, "board": {"name": Path(filename).stem, "filename": Path(filename).name,
            "sha256": hashlib.sha256(data).hexdigest(), "stage": stage, "stage_evidence": "reviewer-declared; not connectivity validation",
            "source": source, "bounds_mm": board_bounds, "coordinates": COORDINATES, "layers": layers},
            "components": components, "nets": nets, "tracks": tracks, "vias": vias, "zones": zones,
            "drawings": drawings, "warnings": sorted(warnings)}
