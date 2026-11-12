"""Build the game-ready Kurotake pass. Blender 5.2+, no external dependencies."""
import argparse
import gzip
import bisect
import json
import math
from pathlib import Path
import random
import sys

import bpy
from mathutils import Vector
from mathutils.kdtree import KDTree


def args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output-dir', default='public/assets/touge')
    p.add_argument('--review-dir', default='art/touge')
    p.add_argument('--skip-render', action='store_true')
    return p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def material(name, color, roughness=0.8, metallic=0, emission=0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Roughness'].default_value = roughness
    bs.inputs['Metallic'].default_value = metallic
    if emission:
        bs.inputs['Emission Color'].default_value = (*color, 1)
        bs.inputs['Emission Strength'].default_value = emission
    return m


class Batch:
    def __init__(self):
        self.vertices, self.faces = [], []

    def polygon(self, points):
        base = len(self.vertices)
        self.vertices.extend(tuple(p) for p in points)
        self.faces.append(tuple(range(base, base + len(points))))

    def box(self, centre, size, yaw=0):
        x, y, z = centre
        sx, sy, sz = (v / 2 for v in size)
        c, s = math.cos(yaw), math.sin(yaw)
        pts = [(x + c * a - s * b, y + s * a + c * b, z + d)
               for a, b, d in [(-sx,-sy,-sz),(sx,-sy,-sz),(sx,sy,-sz),(-sx,sy,-sz),
                               (-sx,-sy,sz),(sx,-sy,sz),(sx,sy,sz),(-sx,sy,sz)]]
        for face in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]:
            self.polygon([pts[i] for i in face])

    def object(self, name, mat, collision=False):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.data.materials.append(mat)
        if collision:
            obj['collision'] = 'trimesh'
        return obj


def main():
    opt = args()
    out, review = Path(opt.output_dir).resolve(), Path(opt.review_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    review.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    rng = random.Random(7713)
    asphalt = material('Asphalt / damp aggregate', (.16,.18,.19), .38)
    soil = material('Cut bank / moss', (.115,.145,.10))
    gravel = material('Gravel shoulder', (.23,.24,.21))
    paint = material('Road paint / ivory', (.72,.72,.60), .68, emission=.025)
    steel = material('Galvanized guardrail', (.38,.42,.43), .36, .65)
    wood = material('Cedar bark', (.10,.075,.045))
    needles = [material('Cedar needles '+str(i), c) for i,c in enumerate([(.075,.13,.10),(.095,.16,.12),(.065,.11,.095)])]
    amber = material('Amber reflectors', (.8,.39,.07), .4, emission=.35)
    sign_black = material('Chevron black', (.025,.03,.03))

    # A portable raster texture; procedural Blender shaders would not survive GLB export.
    image = bpy.data.images.new('Asphalt grain', 256, 256)
    pixels = []
    for _ in range(256 * 256):
        n = .34 + rng.uniform(-.045, .045)
        pixels.extend((n*.91, n*.96, n, 1))
    image.pixels.foreach_set(pixels)
    image.pack()
    nodes = asphalt.node_tree.nodes
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    asphalt.node_tree.links.new(tex.outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])

    anchors = [(0,-35),(0,-15),(0,15),(0,50),(-7,85),(-28,110),(-65,124),
               (-100,112),(-113,88),(-108,65),(-82,58),(-54,66),(-29,82),
               (-18,62),(-27,37),(-58,17),(-85,-12),(-102,-47),(-95,-86),
               (-63,-112),(-12,-116),(34,-94),(54,-49),(44,-17),(23,-17),(21,-37)]
    anchors = [Vector((x*1.25, y*1.25, 0)) for x,y in anchors]
    points = []
    for i in range(len(anchors)):
        p0,p1,p2,p3 = [anchors[j % len(anchors)] for j in (i-1,i,i+1,i+2)]
        for k in range(20):
            t = k/20
            points.append(.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t))
    count = len(points)
    rights = []
    for i in range(count):
        tangent = (points[(i+1)%count]-points[(i-1)%count]).normalized()
        rights.append(Vector((tangent.y, -tangent.x, 0)))
    distances = [0.]
    for i in range(count):
        distances.append(distances[-1]+(points[(i+1)%count]-points[i]).length)
    tree = KDTree(count)
    for i,p in enumerate(points): tree.insert(p, i)
    tree.balance()

    def terrain_height(x,y):
        distance = tree.find((x,y,0))[2]
        t = min(1, max(0, (distance-8.5)/25))
        bank = max(3, 16 + 12*math.sin(x*.027) + 11*math.cos(y*.022) + 7*math.sin((x-y)*.046))
        return t*t*(3-2*t)*bank

    road, shoulder, edges, dashes = Batch(), Batch(), Batch(), Batch()
    rail, posts, reflectors = Batch(), Batch(), Batch()
    for i,p in enumerate(points):
        j=(i+1)%count
        q=points[j]
        r,s=rights[i],rights[j]
        def strip(a,b,z,batch):
            batch.polygon([p+r*a+Vector((0,0,z)),p+r*b+Vector((0,0,z)),
                           q+s*b+Vector((0,0,z)),q+s*a+Vector((0,0,z))])
        strip(-4.5,4.5,.024,road)
        for side in [-1,1]:
            lo,hi=sorted([side*4.5,side*5.2])
            strip(lo,hi,.018,shoulder)
            lo,hi=sorted([side*3.98,side*4.09])
            strip(lo,hi,.03,edges)
            # Corrugated beam profile, thick enough for closed collision geometry.
            profile=[(-.025,.44),(.025,.49),(-.025,.56),(.025,.63),(-.025,.70),(-.025,.73),
                     (.055,.73),(.105,.63),(.055,.56),(.105,.49),(.055,.44)]
            for a in range(len(profile)):
                b=(a+1)%len(profile)
                oa,za=profile[a];ob,zb=profile[b]
                rail.polygon([p+r*(side*(5.28+oa))+Vector((0,0,za)),
                              p+r*(side*(5.28+ob))+Vector((0,0,zb)),
                              q+s*(side*(5.28+ob))+Vector((0,0,zb)),
                              q+s*(side*(5.28+oa))+Vector((0,0,za))])
        if i % 3 == 0:
            for side in [-1,1]:
                pos=p+r*(side*5.38)
                posts.box((pos.x,pos.y,.36),(.09,.12,.72),math.atan2(r.y,r.x))
                if i % 6 == 0:
                    pos=p+r*(side*5.17)
                    reflectors.box((pos.x,pos.y,.65),(.055,.15,.10),math.atan2(r.y,r.x))

    def at_distance(d):
        i=min(count-1,bisect.bisect_right(distances,d)-1)
        a=(d-distances[i])/max(1e-6,distances[i+1]-distances[i])
        return points[i].lerp(points[(i+1)%count],a),rights[i].lerp(rights[(i+1)%count],a).normalized()
    for d in range(0,int(distances[-1]),8):
        p,r=at_distance(d)
        q,s=at_distance(min(d+3,distances[-1]-.001))
        dashes.polygon([p-r*.065+Vector((0,0,.031)),p+r*.065+Vector((0,0,.031)),
                        q+s*.065+Vector((0,0,.031)),q-s*.065+Vector((0,0,.031))])
    road_obj=road.object('Road_Surface',asphalt,True)
    uv=road_obj.data.uv_layers.new(name='WorldUV')
    for loop in road_obj.data.loops:
        co=road_obj.data.vertices[loop.vertex_index].co
        uv.data[loop.index].uv=(co.x*.8,co.y*.8)
    shoulder.object('Gravel_Edges',gravel)
    edges.object('Edge_Lines',paint)
    dashes.object('Centre_Dashes',paint)
    rail.object('Guardrails',steel,True)
    posts.object('Guardrail_Posts',steel)
    reflectors.object('Road_Reflectors',amber)

    terrain=Batch()
    resolution=128
    for y in range(resolution+1):
        for x in range(resolution+1):
            px=-340+x*680/resolution;py=-340+y*680/resolution
            terrain.vertices.append((px,py,terrain_height(px,py)))
    for y in range(resolution):
        for x in range(resolution):
            a=y*(resolution+1)+x
            terrain.faces.append((a,a+1,a+resolution+2,a+resolution+1))
    terrain_obj=terrain.object('Terrain_Cut_Bench',soil,True)
    terrain_mat=material('Terrain / moss to slate',(.16,.19,.15))
    terrain_obj.data.materials[0]=terrain_mat
    colors=terrain_obj.data.color_attributes.new(name='TerrainTint',type='FLOAT_COLOR',domain='POINT')
    for vertex in terrain_obj.data.vertices:
        factor=min(1,max(0,(vertex.co.z-3)/32))
        variation=.012*math.sin(vertex.co.x*.11)*math.cos(vertex.co.y*.07)
        low,high=(.115,.145,.10),(.21,.25,.24)
        colors.data[vertex.index].color=tuple(a+(b-a)*factor+variation for a,b in zip(low,high))+(1,)
    color_node=terrain_mat.node_tree.nodes.new('ShaderNodeVertexColor')
    color_node.layer_name='TerrainTint'
    terrain_mat.node_tree.links.new(color_node.outputs['Color'],terrain_mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    for poly in terrain_obj.data.polygons:
        poly.use_smooth=True

    # Merge irregular cedar crowns by spatial chunk, rather than hundreds of draw calls.
    trunks=[Batch() for _ in range(8)]
    crowns=[[Batch() for _ in range(3)] for _ in range(8)]
    planted=0
    for _ in range(2600):
        x=rng.uniform(-260,220);y=rng.uniform(-250,250)
        distance=tree.find((x,y,0))[2]
        if not 11<distance<100: continue
        chunk=min(7,int((x+260)/120)+4*int(y>0))
        z=terrain_height(x,y);height=rng.uniform(8,16);radius=rng.uniform(1.6,2.9)
        trunks[chunk].box((x,y,z+height*.37),(.22,.22,height*.74),rng.random()*math.tau)
        foliage=crowns[chunk][rng.randrange(3)]
        for level in range(7):
            fraction=.23+level*.10
            reach=radius*1.7*(1-fraction)**.7
            branches=5 if level<4 else 4
            for branch in range(branches):
                angle=branch*math.tau/branches+level*1.91+rng.uniform(-.3,.3)
                length=reach*rng.uniform(.82,1.15)
                radial=Vector((math.cos(angle),math.sin(angle),0))
                side=Vector((-radial.y,radial.x,0))
                base=Vector((x,y,z+height*fraction))
                centre=base+radial*(length*.56)
                centre.z-=length*.10
                verts=[base+radial*(length*.08),base+radial*length-Vector((0,0,length*.23)),
                       centre+side*(length*.32),centre-side*(length*.32),
                       centre+Vector((0,0,length*.24)),centre-Vector((0,0,length*.21))]
                for face in [(0,2,4),(2,1,4),(1,3,4),(3,0,4),
                             (2,0,5),(1,2,5),(3,1,5),(0,3,5)]:
                    foliage.polygon([verts[k] for k in face])
        planted+=1
        if planted>=560: break
    for i in range(8):
        if trunks[i].vertices: trunks[i].object('Cedar_Trunks_%02d'%i,wood)
        for j in range(3):
            if crowns[i][j].vertices: crowns[i][j].object('Cedar_Canopy_%02d_%d'%(i,j),needles[j])

    # Painted chevrons on the outer edge of the main hairpin.
    signs,arrows=Batch(),Batch()
    for index in [130,140,150,160,170,180,190]:
        p,r=points[index],rights[index]
        pos=p+r*6.1
        yaw=math.atan2(r.y,r.x)
        posts_sign=Batch()
        posts_sign.box((pos.x,pos.y,.75),(.07,.07,1.5))
        posts_sign.object('Chevron_Post_%d'%index,steel)
        signs.box((pos.x,pos.y,1.35),(.055,1.05,.62),yaw)
        verts=[(-.32,1.12),(.02,1.35),(-.32,1.58),(-.12,1.58),(.22,1.35),(-.12,1.12)]
        arrows.polygon([(pos.x+math.cos(yaw)*(-.031)-math.sin(yaw)*yy,
                         pos.y+math.sin(yaw)*(-.031)+math.cos(yaw)*yy,zz) for yy,zz in verts])
    signs.object('Hairpin_Chevrons',paint)
    arrows.object('Hairpin_Arrows',sign_black)

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(out/'mountain_pass.glb'),export_format='GLB',use_selection=True,
                              export_yup=True,export_apply=True,export_animations=False,
                              export_cameras=False,export_lights=False,export_extras=True)
    (out/'mountain_pass.glb.gz').write_bytes(
        gzip.compress((out/'mountain_pass.glb').read_bytes(), compresslevel=9, mtime=0))
    route={'name':'Kurotake Pass','width':9,'length':distances[-1],
           'points':[{'x':p.x,'y':.024,'z':-p.y} for p in points]}
    (out/'route.json').write_text(json.dumps(route,separators=(',',':')))
    triangles=0
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH':
            obj.data.calc_loop_triangles();triangles+=len(obj.data.loop_triangles)
    (out/'pass_manifest.json').write_text(json.dumps({'blender':bpy.app.version_string,'triangles':triangles,
                                                    'trees':planted,'route_length_m':distances[-1]},indent=2))
    print('PASS_EXPORTED',triangles,'triangles;',planted,'trees;',round(distances[-1]),'metres')

    # Review lighting is intentionally separate from the exported environment.
    if (out/'coupe.glb').exists():
        before=set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(out/'coupe.glb'))
        imported=set(bpy.data.objects)-before
        for obj in imported:
            if obj.name.startswith('CAR_ROOT'): obj.location.z=.55
            if obj.name in ['Wheel_FL','Wheel_FR','Wheel_RL','Wheel_RR']: obj.location.z=-.19
    world=bpy.context.scene.world or bpy.data.worlds.new('Review World')
    bpy.context.scene.world=world;world.use_nodes=True
    world.node_tree.nodes.get('Background').inputs[0].default_value=(.16,.21,.25,1)
    world.node_tree.nodes.get('Background').inputs[1].default_value=.5
    bpy.ops.object.light_add(type='SUN',location=(0,0,100))
    bpy.context.object.rotation_euler=(math.radians(27),math.radians(-22),math.radians(-35))
    bpy.context.object.data.energy=2
    bpy.ops.object.camera_add(location=(220,-270,210))
    camera=bpy.context.object
    camera.rotation_euler=(Vector((-35,5,0))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.lens=42
    scene=bpy.context.scene;scene.camera=camera;scene.render.engine='BLENDER_EEVEE'
    scene.render.resolution_x=1280;scene.render.resolution_y=800;scene.render.resolution_percentage=100
    scene.render.film_transparent=False
    bpy.ops.wm.save_as_mainfile(filepath=str(review/'pass.blend'))
    if not opt.skip_render:
        scene.render.filepath=str(review/'pass_preview.png')
        bpy.ops.render.render(write_still=True)


if __name__=='__main__':
    main()
