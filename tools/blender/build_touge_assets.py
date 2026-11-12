"""Build the original ivory coupe asset for Touge Midnight Run (Blender 5.2 LTS).

blender --background --factory-startup --python-exit-code 1 \
  --python tools/blender/build_touge_assets.py -- \
  --output-dir public/assets/touge --review-dir art/touge [--skip-render]

Blender axes: +X right, +Y forward, +Z up. CAR_ROOT is the physics centre of mass.
Only stdlib + bpy/bmesh/mathutils; no network, no subprocess, no downloads.
"""
import argparse
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

SEED = 7713
WHEEL_R, WHEEL_W, HALF_TRACK, AXLE_Y = 0.33, 0.22, 0.86, 1.25
ARCH_Z, ARCH_R = -0.18, 0.40
PREVIEW_ROOT_Z, PREVIEW_WHEEL_Z = 0.524, -0.19
WHEELS = {"Wheel_FL": (-HALF_TRACK, AXLE_Y, 0.0), "Wheel_FR": (HALF_TRACK, AXLE_Y, 0.0),
          "Wheel_RL": (-HALF_TRACK, -AXLE_Y, 0.0), "Wheel_RR": (HALF_TRACK, -AXLE_Y, 0.0)}
# The wide-body shell wraps tyres reaching x=0.97. The game collider is
# 0.96 half-wide to match the imported body with a small visual margin.
# Body half-section (u = x / half-width, v = 0 bottom .. 1 top), bottom to top.
PROFILE = [(0.40, 0.00), (0.82, 0.00), (0.94, 0.03), (0.98, 0.10), (0.99, 0.22), (1.00, 0.50),
           (0.99, 0.72), (0.96, 0.87), (0.88, 0.96), (0.70, 1.00), (0.30, 1.02)]
# Loft stations front to rear: (y, half-width, z bottom, z top).
STATIONS = [(2.00, 0.86, -0.24, 0.12), (1.96, 0.93, -0.28, 0.17), (1.80, 0.97, -0.30, 0.205),
            (1.25, 1.00, -0.30, 0.25), (0.75, 1.00, -0.30, 0.295), (0.20, 1.00, -0.30, 0.30),
            (-0.60, 1.00, -0.30, 0.30), (-1.25, 1.00, -0.30, 0.30), (-1.45, 1.00, -0.30, 0.30),
            (-1.80, 0.98, -0.30, 0.29), (-1.96, 0.95, -0.28, 0.275), (-2.00, 0.90, -0.25, 0.26)]
# Greenhouse rings bottom to top: (z, half-width, y front, y rear, corner radius).
GH_RINGS = [(0.24, 0.87, 0.74, -1.44, 0.08), (0.30, 0.855, 0.66, -1.36, 0.08),
            (0.50, 0.78, 0.33, -1.09, 0.075), (0.70, 0.685, -0.02, -0.80, 0.07),
            (0.745, 0.64, -0.10, -0.73, 0.07), (0.757, 0.45, -0.26, -0.58, 0.05)]
B_PILLAR_Y = -0.45

MATS = {}    # name -> bpy material
PARTS = {}   # static body geometry: material name -> (verts, faces)
BVH = None   # ray-cast tree of the finished body shell


# ----------------------------------------------------------------- helpers
def make_material(name, color, metallic=0.0, rough=0.5, coat=0.0, coat_rough=0.05, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    nt.nodes.clear()
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (300, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    values = {"Base Color": (*color, 1.0), "Metallic": metallic, "Roughness": rough,
              "Coat Weight": coat, "Coat Roughness": coat_rough,
              "Emission Color": (*(emit or (0.0, 0.0, 0.0)), 1.0), "Emission Strength": strength}
    for key, val in values.items():
        bsdf.inputs[key].default_value = val
    m.diffuse_color = (*color, 1.0)
    MATS[name] = m


def make_materials():
    make_material("Paint", (0.86, 0.80, 0.66), 0.2, 0.32, 1.0, 0.06)        # ivory pearl
    make_material("Graphite", (0.09, 0.095, 0.10), 0.1, 0.55)
    make_material("Glass", (0.012, 0.018, 0.035), 0.0, 0.06, 1.0, 0.03)     # opaque blue-black
    make_material("Black", (0.012, 0.012, 0.014), 0.0, 0.7)
    make_material("Rubber", (0.02, 0.02, 0.022), 0.0, 0.85)
    make_material("Alloy", (0.72, 0.73, 0.75), 1.0, 0.28)
    make_material("HeadLens", (0.90, 0.92, 0.95), 0.0, 0.08, 1.0, 0.03, (1.0, 0.95, 0.82), 1.5)
    make_material("TailLamp", (0.55, 0.01, 0.01), 0.0, 0.15, 1.0, 0.05, (1.0, 0.03, 0.02), 2.0)
    make_material("Amber", (0.90, 0.40, 0.03), 0.0, 0.2, 0.0, 0.05, (1.0, 0.45, 0.05), 0.6)
    make_material("Plate", (0.90, 0.90, 0.86), 0.0, 0.5)
    make_material("Slate", (0.045, 0.052, 0.062), 0.0, 0.55)                # preview floor only


def emit(bm, mats, xf=None, parts=None):
    """Append bmesh faces to per-material vertex/face lists."""
    parts = PARTS if parts is None else parts
    bm.verts.index_update()
    remap = {}
    for f in bm.faces:
        name = mats[min(f.material_index, len(mats) - 1)]
        vs, fs = parts.setdefault(name, ([], []))
        idx = []
        for v in f.verts:
            key = (name, v.index)
            if key not in remap:
                remap[key] = len(vs)
                vs.append(tuple(xf @ v.co) if xf else tuple(v.co))
            idx.append(remap[key])
        fs.append(idx)


def part(bm, mat, xf=None, parts=None):
    emit(bm, [mat], xf, parts)
    bm.free()


def box(size, loc, bevel=0.0, seg=2, taper=1.0):
    """Bevelled box; taper scales Y of the +Z end (used by the spokes)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        ty = taper if v.co.z > 0 else 1.0
        v.co = Vector((v.co.x * size[0], v.co.y * size[1] * ty, v.co.z * size[2]))
    if bevel > 0.0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, offset_type='OFFSET',
                        segments=seg, profile=0.5, affect='EDGES')
    bmesh.ops.translate(bm, verts=bm.verts[:], vec=Vector(loc))
    return bm


def lathe(profile, seg, closed=False):
    """Revolve (axial x, radius) points about the X axis."""
    bm = bmesh.new()
    rings = []
    for k in range(seg):
        a = 2.0 * math.pi * k / seg
        rings.append([bm.verts.new((x, r * math.cos(a), r * math.sin(a))) for x, r in profile])
    n = len(profile)
    for k in range(seg):
        A, B = rings[k], rings[(k + 1) % seg]
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            bm.faces.new((A[i], A[j], B[j], B[i]))
    return bm


def lin(a, b, n):
    return [a + (b - a) * i / (n - 1) for i in range(n)]


def hit(origin, direction):
    h = BVH.ray_cast(Vector(origin), Vector(direction))[0]
    if h is None:
        raise RuntimeError("ray missed body: %r %r" % (origin, direction))
    return h


def ribbon(pts, d, wid=0.008, lift=0.0025, mat="Black"):
    """Thin shut-line strip projected onto the body along direction d."""
    d = Vector(d)
    pts = [Vector(p) for p in pts]
    bm = bmesh.new()
    rows = []
    for i, p in enumerate(pts):
        t = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        s = t.cross(d).normalized() * (wid / 2.0)
        hs = [BVH.ray_cast(p + s * k, d)[0] for k in (-1.0, 1.0)]
        rows.append(None if any(h is None for h in hs) else [bm.verts.new(h - d * lift) for h in hs])
    for a, b in zip(rows, rows[1:]):
        if a and b:
            bm.faces.new((a[0], a[1], b[1], b[0]))
    part(bm, mat)


def build_object(name, parts, parent, col, sx=1.0):
    """One mesh object from material->(verts, faces); sx=-1 mirrors across X."""
    verts, faces, fmat, names = [], [], [], []
    for mname in sorted(parts):
        vs, fs = parts[mname]
        off = len(verts)
        verts += [(x * sx, y, z) for x, y, z in vs]
        faces += [[i + off for i in f] for f in fs]
        fmat += [len(names)] * len(fs)
        names.append(mname)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    for mname in names:
        me.materials.append(MATS[mname])
    me.polygons.foreach_set("material_index", fmat)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    try:
        me.set_sharp_from_angle(angle=math.radians(40.0))
    except Exception:
        pass
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    ob.parent = parent
    return ob


# ----------------------------------------------------------------- body shell
def body_cage():
    """Closed quad loft through STATIONS; slots 0 Black (arch liners), 1 Paint, 2 Graphite."""
    bm = bmesh.new()
    n = len(PROFILE)
    N = 2 * n
    rings = []
    for y, w, zb, zt in STATIONS:
        R = [bm.verts.new((u * w, y, zb + v * (zt - zb))) for u, v in PROFILE]
        L = [bm.verts.new((-u * w, y, zb + v * (zt - zb))) for u, v in PROFILE]
        rings.append(R + L[::-1])

    def slot(k, bumper):  # k = profile segment index; lower segments are graphite
        return 2 if k <= (4 if bumper else 3) else 1

    for s in range(len(STATIONS) - 1):
        A, B = rings[s], rings[s + 1]
        bumper = min(abs(STATIONS[s][0]), abs(STATIONS[s + 1][0])) >= 1.79
        for i in range(N):
            f = bm.faces.new((A[i], A[(i + 1) % N], B[(i + 1) % N], B[i]))
            if i == n - 1:
                f.material_index = 1            # hood / roof-side top span
            elif i == N - 1:
                f.material_index = 2            # floor span
            else:
                f.material_index = slot(i if i < n - 1 else N - 2 - i, bumper)
    for ring in (rings[0], rings[-1]):          # fascia caps as full-width quad strips
        for k in range(n - 1):
            f = bm.faces.new((ring[k], ring[k + 1], ring[N - 2 - k], ring[N - 1 - k]))
            f.material_index = slot(k, True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def build_body(col):
    """Loft -> subsurf -> boolean wheel arches -> bevel, evaluated to a final mesh."""
    global BVH
    cage = body_cage()
    me = bpy.data.meshes.new("BodyCage")
    cage.to_mesh(me)
    cage.free()
    for name in ("Black", "Paint", "Graphite"):
        me.materials.append(MATS[name])
    ob = bpy.data.objects.new("BodyCage", me)
    col.objects.link(ob)

    cut = bmesh.new()
    for sx in (-1.0, 1.0):
        for y in (AXLE_Y, -AXLE_Y):
            mx = Matrix.Translation((sx * 1.05, y, ARCH_Z)) @ Matrix.Rotation(math.radians(90.0), 4, 'Y')
            bmesh.ops.create_cone(cut, cap_ends=True, cap_tris=False, segments=48,
                                  radius1=ARCH_R, radius2=ARCH_R, depth=0.70, matrix=mx)
    bmesh.ops.recalc_face_normals(cut, faces=cut.faces[:])
    cme = bpy.data.meshes.new("ArchCutters")
    cut.to_mesh(cme)
    cut.free()
    cob = bpy.data.objects.new("ArchCutters", cme)
    col.objects.link(cob)

    m = ob.modifiers.new("Subsurf", 'SUBSURF')
    m.levels = 2
    m.render_levels = 2
    m = ob.modifiers.new("Arches", 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.object = cob
    m.solver = 'EXACT'
    m = ob.modifiers.new("ArchBevel", 'BEVEL')
    m.width = 0.012
    m.segments = 2
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(50.0)

    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    final = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bm = bmesh.new()
    bm.from_mesh(final)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    emit(bm, ["Black", "Paint", "Graphite"])
    BVH = BVHTree.FromBMesh(bm)
    bm.free()
    for o in (ob, cob):
        bpy.data.objects.remove(o, do_unlink=True)
    for d in (me, cme, final):
        bpy.data.meshes.remove(d)


def build_greenhouse():
    """Rounded-rectangle rings lofted upward: glass panes, thin painted pillars, roof panel."""
    bm = bmesh.new()
    cs = 3
    rings, tags = [], []
    for z, hw, yf, yr, r in GH_RINGS:
        vs, tags = [], []

        def arc(cx, cy, a0):
            for k in range(cs + 1):
                a = math.radians(a0 + 90.0 * k / cs)
                vs.append(bm.verts.new((cx + r * math.cos(a), cy + r * math.sin(a), z)))
                tags.append(0 if k < cs else 1)     # 0 = pillar (paint), 1 = glass pane follows

        def pillar(x, y0, y1):
            vs.append(bm.verts.new((x, y0, z)))
            tags.append(0)
            vs.append(bm.verts.new((x, y1, z)))
            tags.append(1)

        arc(hw - r, yf - r, 0.0)                                  # A pillar right, then windshield
        arc(r - hw, yf - r, 90.0)                                 # A pillar left, then door glass
        pillar(-hw, B_PILLAR_Y + 0.025, B_PILLAR_Y - 0.025)       # B pillar left
        arc(r - hw, yr + r, 180.0)                                # C pillar left, then rear glass
        arc(hw - r, yr + r, 270.0)                                # C pillar right
        pillar(hw, B_PILLAR_Y - 0.025, B_PILLAR_Y + 0.025)        # B pillar right
        rings.append(vs)
    N = len(rings[0])
    for ri in range(len(rings) - 1):
        A, B = rings[ri], rings[ri + 1]
        for i in range(N):
            f = bm.faces.new((A[i], A[(i + 1) % N], B[(i + 1) % N], B[i]))
            f.material_index = tags[i] if ri in (1, 2) else 0
    bm.faces.new(rings[-1])                                       # roof panel
    emit(bm, ["Paint", "Glass"])
    bm.free()


# ----------------------------------------------------------------- details
def plate_text(col, text, loc):
    cu = bpy.data.curves.new("PlateText", 'FONT')
    cu.body = text
    cu.size = 0.105
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.extrude = 0.002
    cu.resolution_u = 4
    ob = bpy.data.objects.new("PlateText", cu)
    col.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    if len(me.polygons) == 0:
        raise RuntimeError("plate text produced no mesh")
    bm = bmesh.new()
    bm.from_mesh(me)
    # Text faces -Y (rearward), reads along +X, up is +Z.
    part(bm, "Black", Matrix.Translation(loc) @ Matrix.Rotation(math.radians(90.0), 4, 'X'))
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    bpy.data.meshes.remove(me)


def build_details(col):
    front, back, down = (0.0, -1.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, -1.0)
    # Front fascia: upper grille with slats, lower intake, lenses, indicators.
    fy = hit((0.0, 3.0, 0.02), front).y
    part(box((0.56, 0.04, 0.075), (0.0, fy - 0.012, 0.02), 0.006), "Black")
    for i in range(4):
        part(box((0.54, 0.02, 0.007), (0.0, fy - 0.002, 0.02 + (i - 1.5) * 0.018)), "Graphite")
    fy2 = hit((0.0, 3.0, -0.15), front).y
    part(box((1.0, 0.04, 0.085), (0.0, fy2 - 0.012, -0.15), 0.008), "Black")
    for i in range(3):
        part(box((0.98, 0.02, 0.008), (0.0, fy2 - 0.002, -0.15 + (i - 1) * 0.024)), "Graphite")
    for s in (-1.0, 1.0):
        hy = hit((s * 0.54, 3.0, 0.02), front).y
        part(box((0.40, 0.07, 0.085), (s * 0.54, hy - 0.025, 0.02), 0.012), "HeadLens")
        ay = hit((s * 0.68, 3.0, -0.105), front).y
        part(box((0.14, 0.04, 0.035), (s * 0.68, ay - 0.012, -0.105), 0.006), "Amber")
    # Rear fascia: tail lamps, plate with meshed text, lip, exhaust.
    for s in (-1.0, 1.0):
        ty = hit((s * 0.55, -3.0, 0.12), back).y
        part(box((0.46, 0.06, 0.12), (s * 0.55, ty + 0.02, 0.12), 0.012), "TailLamp")
    ry = hit((0.0, -3.0, 0.115), back).y
    part(box((0.33, 0.02, 0.165), (0.0, ry - 0.004, 0.115), 0.003, 1), "Plate")
    plate_text(col, "77-13", (0.0, ry - 0.0165, 0.115))
    lz = hit((0.0, -1.92, 2.0), down).z
    part(box((1.40, 0.10, 0.035), (0.0, -1.92, lz + 0.012), 0.012), "Paint")
    pipe = lathe([(-1.70, 0.040), (-2.04, 0.040), (-2.04, 0.032), (-1.80, 0.032), (-1.80, 0.004)], 24)
    part(pipe, "Alloy", Matrix.Translation((-0.50, 0.0, -0.30)) @ Matrix.Rotation(math.radians(90.0), 4, 'Z'))
    # Cowl, mirrors, handles.
    part(box((1.60, 0.10, 0.024), (0.0, 0.69, 0.30), 0.006), "Black")
    for s in (-1.0, 1.0):
        part(box((0.16, 0.09, 0.11), (s * 0.97, 0.47, 0.37), 0.02), "Paint")
        part(box((0.10, 0.05, 0.10), (s * 0.90, 0.47, 0.29), 0.008), "Black")
        hx = hit((s * 3.0, -0.38, 0.17), (-s, 0.0, 0.0)).x
        part(box((0.03, 0.13, 0.03), (hx, -0.38, 0.17), 0.006), "Black")
        # Door shut lines projected onto the flank.
        d = (-s, 0.0, 0.0)
        for y in (0.45, -0.50):
            ribbon([(s * 3.0, y, z) for z in lin(-0.15, 0.255, 9)], d)
        ribbon([(s * 3.0, y, -0.15) for y in lin(0.45, -0.50, 7)], d)
        # Hood and boot shut lines projected from above.
        ribbon([(s * 0.66, y, 2.0) for y in lin(0.78, 1.88, 10)], down)
        ribbon([(s * 0.66, y, 2.0) for y in lin(-1.47, -1.85, 5)], down)
    ribbon([(x, 1.88, 2.0) for x in lin(-0.66, 0.66, 9)], down)
    ribbon([(x, -1.47, 2.0) for x in lin(-0.66, 0.66, 9)], down)


# ----------------------------------------------------------------- wheels
def wheel_parts():
    """Wheel centred on the origin, axle along X, outer face at +X."""
    P = {}
    seg = 64
    hw = WHEEL_W / 2.0
    R = WHEEL_R
    tire = [(-0.095, 0.215), (-hw + 0.002, 0.25), (-hw, 0.29), (-0.10, R - 0.012), (-0.085, R)]
    for gx in (-0.045, 0.0, 0.045):                 # three circumferential tread grooves
        tire += [(gx - 0.006, R), (gx - 0.006, R - 0.010), (gx + 0.006, R - 0.010), (gx + 0.006, R)]
    tire += [(0.085, R), (0.10, R - 0.012), (hw, 0.29), (hw - 0.002, 0.25), (0.095, 0.215)]
    part(lathe(tire, seg, True), "Rubber", None, P)
    rim = [(-0.100, 0.226), (-0.105, 0.214), (-0.100, 0.200), (0.085, 0.200),
           (0.104, 0.212), (0.108, 0.222), (0.104, 0.228)]
    part(lathe(rim, seg), "Alloy", None, P)
    part(lathe([(0.050, 0.065), (0.085, 0.065), (0.094, 0.055), (0.097, 0.004)], seg), "Alloy", None, P)
    part(lathe([(0.0, 0.06), (0.0, 0.175), (0.02, 0.175), (0.02, 0.06)], seg, True), "Alloy", None, P)
    for k in range(5):                              # five tapered, bevelled spokes
        spoke = box((0.028, 0.055, 0.150), (0.072, 0.0, 0.128), 0.006, 2, 0.65)
        part(spoke, "Alloy", Matrix.Rotation(math.radians(72.0 * k), 4, 'X'), P)
    return P


# ----------------------------------------------------------------- scene, export, preview
def validate(root, car_objs):
    eps = 1e-6
    ident = Matrix.Identity(4)
    if any(abs(root.matrix_world[i][j] - ident[i][j]) > eps for i in range(4) for j in range(4)):
        raise RuntimeError("CAR_ROOT is not at identity")
    for name, loc in WHEELS.items():
        ob = bpy.data.objects.get(name)
        if ob is None or ob.type != 'EMPTY' or ob.parent is not root:
            raise RuntimeError("missing wheel pivot " + name)
        ml = ob.matrix_local
        if (ml.translation - Vector(loc)).length > eps:
            raise RuntimeError("wheel pivot misplaced: " + name)
        if any(abs(ml[i][j] - ident[i][j]) > eps for i in range(3) for j in range(3)):
            raise RuntimeError("wheel pivot rotation/scale not identity: " + name)
        if not any(c.type == 'MESH' for c in ob.children):
            raise RuntimeError("wheel pivot has no mesh: " + name)
    for ob in car_objs:
        if ob.type == 'MESH':
            if len(ob.data.polygons) == 0:
                raise RuntimeError("empty mesh " + ob.name)
            if not all(math.isfinite(c) for v in ob.data.vertices for c in v.co):
                raise RuntimeError("non-finite vertex in " + ob.name)


def stats(car_objs):
    per, mats, tris = {}, set(), 0
    for ob in car_objs:
        if ob.type != 'MESH':
            continue
        ob.data.calc_loop_triangles()
        n = len(ob.data.loop_triangles)
        per[ob.name] = {"triangles": n, "vertices": len(ob.data.vertices),
                        "materials": [m.name for m in ob.data.materials]}
        mats.update(m.name for m in ob.data.materials)
        tris += n
    return {"mesh_count": len(per), "triangle_count": tris, "material_count": len(mats),
            "materials": sorted(mats), "meshes": per}


def aim(ob, loc, target):
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()


def build_studio(scene):
    col = bpy.data.collections.new("Studio")
    scene.collection.children.link(col)
    fm = bpy.data.meshes.new("PreviewFloor")
    s = 30.0
    fm.from_pydata([(-s, -s, 0.0), (s, -s, 0.0), (s, s, 0.0), (-s, s, 0.0)], [], [(0, 1, 2, 3)])
    fm.materials.append(MATS["Slate"])
    col.objects.link(bpy.data.objects.new("PreviewFloor", fm))
    for name, loc, energy, size in (("KeyLight", (3.5, 4.0, 6.0), 2600.0, 6.0),
                                    ("FillLight", (-5.5, 1.0, 3.5), 1200.0, 7.0),
                                    ("RearLight", (-3.0, -5.0, 5.5), 2200.0, 6.0),
                                    ("TopLight", (0.0, 0.0, 7.0), 1200.0, 9.0)):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        col.objects.link(lo)
        aim(lo, loc, (0.0, 0.0, 0.5))
    cams = {}
    for name, loc in (("Cam_Front34", (4.2, 5.6, 1.7)), ("Cam_Rear34", (-4.2, -5.6, 1.7))):
        cd = bpy.data.cameras.new(name)
        cd.lens = 50.0
        co = bpy.data.objects.new(name, cd)
        col.objects.link(co)
        aim(co, loc, (0.0, 0.0, 0.58))
        cams[name] = co
    world = scene.world or bpy.data.worlds.new("StudioWorld")
    scene.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = world.node_tree.nodes.get("Background") if world.node_tree else None
    if bg:
        bg.inputs[0].default_value = (0.02, 0.022, 0.027, 1.0)
        bg.inputs[1].default_value = 1.0
    return cams


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="build_touge_assets.py")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--review-dir", required=True)
    ap.add_argument("--skip-render", action="store_true")
    args = ap.parse_args(argv)
    out_dir = os.path.abspath(args.output_dir)
    review_dir = os.path.abspath(args.review_dir)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(review_dir, exist_ok=True)
    random.seed(SEED)

    scene = bpy.context.scene
    for ob in list(bpy.data.objects):               # factory cube / light / camera only
        bpy.data.objects.remove(ob, do_unlink=True)
    col = bpy.data.collections.new("Car")
    scene.collection.children.link(col)
    make_materials()

    root = bpy.data.objects.new("CAR_ROOT", None)
    root.empty_display_size = 0.3
    root["asset"] = "touge_coupe"
    root["origin"] = "physics centre of mass"
    root["plate"] = "77-13"
    col.objects.link(root)

    build_body(col)
    build_greenhouse()
    build_details(col)
    for mname in sorted(PARTS):                     # static parts merged per material
        build_object("Body_" + mname, {mname: PARTS[mname]}, root, col)
    wp = wheel_parts()
    for name, loc in WHEELS.items():
        pivot = bpy.data.objects.new(name, None)
        pivot.empty_display_size = 0.2
        pivot.location = loc
        pivot.parent = root
        col.objects.link(pivot)
        build_object(name + "_Mesh", wp, pivot, col, -1.0 if loc[0] < 0.0 else 1.0)

    bpy.context.view_layer.update()
    car_objs = list(col.objects)
    validate(root, car_objs)
    info = stats(car_objs)
    warnings = []
    if not 20000 <= info["triangle_count"] <= 80000:
        warnings.append("triangle_count outside 20k-80k target")

    # Export the identity pose, car hierarchy only, before any preview posing.
    for ob in bpy.context.view_layer.objects:
        ob.select_set(False)
    for ob in car_objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = root
    glb = os.path.join(out_dir, "coupe.glb")
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True,
                              export_yup=True, export_apply=True, export_animations=False,
                              export_cameras=False, export_lights=False, export_extras=True,
                              export_draco_mesh_compression_enable=False)

    # Preview pose only: settle on the floor at rest ride height.
    root.location.z = PREVIEW_ROOT_Z
    for name in WHEELS:
        bpy.data.objects[name].location.z = PREVIEW_WHEEL_Z
    cams = build_studio(scene)
    scene.camera = cams["Cam_Front34"]
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 800
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    blend = os.path.join(review_dir, "coupe.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)

    renders = []
    if not args.skip_render:
        for cam_name, fname in (("Cam_Front34", "coupe_front34.png"), ("Cam_Rear34", "coupe_rear34.png")):
            scene.camera = cams[cam_name]
            scene.render.filepath = os.path.join(review_dir, fname)
            bpy.ops.render.render(write_still=True)
            renders.append(scene.render.filepath)

    manifest = {
        "asset": "coupe", "seed": SEED, "blender_version": bpy.app.version_string,
        "glb": glb, "blend": blend, "renders": renders, "render_skipped": bool(args.skip_render),
        "axes": {"blender": "+X right, +Y forward, +Z up", "gltf": "+Y up, forward -Z"},
        "root": "CAR_ROOT (identity, physics centre of mass)",
        "wheel_pivots_blender": {k: list(v) for k, v in WHEELS.items()},
        "wheel_radius": WHEEL_R, "wheel_width": WHEEL_W, "arch_centre_z": ARCH_Z,
        "collider_half_extents_blender_xyz": [0.96, 2.0, 0.30],
        "visual_body_half_width": 1.0, "roof_z": GH_RINGS[-1][0],
        "preview_pose_only": {"root_z": PREVIEW_ROOT_Z, "wheel_z": PREVIEW_WHEEL_Z},
        "warnings": warnings,
    }
    manifest.update(info)
    with open(os.path.join(out_dir, "build_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print("[touge] wrote %s: %d meshes, %d triangles, %d materials"
          % (glb, info["mesh_count"], info["triangle_count"], info["material_count"]))
    for w in warnings:
        print("[touge] WARNING: " + w)


main()
