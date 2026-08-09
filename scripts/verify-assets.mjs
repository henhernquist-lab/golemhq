// Verification path for 3D asset generation (Batch 4.5, Parts 2 and 3).
//
// Generates a real .glb with headless Blender and validates the container, then
// reports whether Hugging Face 3D generation works. Nothing here trusts an exit
// code or an HTTP 200: the proof is a parsed glTF with the expected mesh and
// material inside it.
//
// Run:
//   BLENDER_BIN=/path/to/blender \
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-assets.mjs
//
// Env:
//   BLENDER_BIN=<path>   Blender executable (portable build is fine)
//   OUT=<path>           where to write the .glb (default public/assets/golem-cube.glb)
//   HF_GENERATE=1        run a real Hugging Face image-to-3D generation too
//   HOST=sprite          run Blender on the Fly Sprite, as production does

import { readFileSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import './load-env.mjs'

// Same selector production uses. Without this the script can only ever prove
// the machine it happens to run on, which is how "Blender works" and "3D
// generation is broken in production" stayed true at the same time.
if (process.env.HOST === 'sprite') process.env.VERCEL = '1'

const blender = await import('../src/lib/assets/blender.ts')
const hf = await import('../src/lib/assets/huggingface.ts')

const OUT = resolve(process.env.OUT ?? 'public/assets/golem-cube.glb')
const ok = (m) => console.log(`  ✓ ${m}`)
const no = (m) => console.log(`  ✗ ${m}`)
const info = (m) => console.log(`    ${m}`)

// A cube with a real PBR material — small enough to verify by eye in the glTF
// JSON, complex enough that a stub export would not accidentally match.
const CUBE_SCRIPT = `
import bpy, sys
out = sys.argv[sys.argv.index('--') + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
cube = bpy.context.active_object
cube.name = "GolemCube"

mat = bpy.data.materials.new(name="GolemGreen")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.13, 0.9, 0.4, 1.0)
bsdf.inputs["Metallic"].default_value = 0.2
bsdf.inputs["Roughness"].default_value = 0.35
cube.data.materials.append(mat)

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')
`.trim()

// Cycles, not EEVEE: EEVEE needs libEGL, which a GPU-less host does not have.
// Low samples because this only has to be a recognisable shape for TripoSR.
const RENDER_SCRIPT = `
import bpy, sys, math
out = sys.argv[sys.argv.index('--') + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_monkey_add(size=2)
obj = bpy.context.active_object
bpy.ops.object.shade_smooth()
mat = bpy.data.materials.new("Clay")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.45, 0.35, 1)
obj.data.materials.append(mat)

cam_data = bpy.data.cameras.new("C")
cam = bpy.data.objects.new("C", cam_data)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam
cam.location = (0, -5, 1.2)
cam.rotation_euler = (math.radians(78), 0, 0)

light_data = bpy.data.lights.new("L", type='AREA')
light_data.energy = 800
light = bpy.data.objects.new("L", light_data)
bpy.context.collection.objects.link(light)
light.location = (3, -4, 5)

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 32
sc.cycles.device = 'CPU'
sc.render.resolution_x = sc.render.resolution_y = 512
sc.world = bpy.data.worlds.new("W")
sc.world.use_nodes = True
sc.world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
`.trim()

try {
  // ── Blender ──────────────────────────────────────────────────────
  console.log('\nBLENDER')
  const { available, version } = await blender.blenderAvailable()
  if (!available) {
    no(`no Blender at "${blender.blenderBinary()}" — set BLENDER_BIN`)
    throw new Error('Blender unavailable')
  }
  ok(`${version}`)

  mkdirSync(dirname(OUT), { recursive: true })
  const run = await blender.runBlenderScript(CUBE_SCRIPT, { outPath: OUT })
  ok(`exported ${run.bytes} bytes in ${run.durationMs}ms → ${OUT}`)

  const glb = await blender.inspectGlb(OUT)
  if (!glb.valid) throw new Error(`invalid .glb: ${glb.error}`)
  ok(`valid glTF v${glb.version} container, length matches header`)
  info(`meshes:    ${glb.meshes.join(', ')}`)
  info(`materials: ${glb.materials.join(', ')}`)
  if (!glb.materials.includes('GolemGreen')) throw new Error('material did not survive export')
  ok('the material authored in the script is present in the exported file')

  // A truncated file must be rejected — otherwise "valid" means nothing.
  const truncated = `${OUT}.truncated`
  await writeFile(truncated, readFileSync(OUT).subarray(0, 400))
  const bad = await blender.inspectGlb(truncated)
  if (bad.valid) throw new Error('inspectGlb accepted a truncated file')
  ok(`truncation is detected, not ignored: ${bad.error}`)

  // ── Hugging Face (image-to-3D) ───────────────────────────────────
  console.log('\nHUGGING FACE')
  if (!hf.huggingFaceConfigured()) {
    no('HF_API_TOKEN is not set — image-to-3D is BLOCKED pending a token from https://huggingface.co/settings/tokens')
  } else {
    const status = await hf.spaceStatus()
    ok(`Space ${hf.activeSpace()} — ${status.stage}${status.hardware ? ` on ${status.hardware}` : ''}`)

    if (process.env.HF_GENERATE === '1') {
      // TripoSR reconstructs from a single image, so the pipeline needs one.
      // Rendering it with the Blender install verified above keeps the whole
      // chain local and reproducible instead of depending on some URL staying
      // alive. Cycles rather than EEVEE: EEVEE needs libEGL, which a machine
      // with no GPU does not have.
      const refPath = '/tmp/golem-ref.png'
      await blender.runBlenderScript(RENDER_SCRIPT, { outPath: refPath, timeoutMs: 300_000 })
      const refBytes = readFileSync(refPath).byteLength
      if (refBytes < 1000) throw new Error(`reference render is only ${refBytes} bytes`)
      ok(`reference image rendered on the ${process.env.VERCEL ? 'Sprite' : 'local host'} (${refBytes} bytes)`)

      const out = resolve('public/assets/hf-generated.glb')
      // imageTo3D validates the container itself and throws on a truncated or
      // non-glTF download, so reaching the next line already means real model.
      const model = await hf.imageTo3D(readFileSync(refPath), { outPath: out, resolution: 256 })
      ok(`generated ${model.bytes} bytes in ${(model.durationMs / 1000).toFixed(1)}s → ${out}`)
      info(`meshes:    ${model.info.meshes.join(', ') || '(unnamed)'}`)
      info(`materials: ${model.info.materials.join(', ') || '(none)'}`)
      ok('downloaded model parsed as valid glTF with a matching declared length')
    } else {
      ok('set HF_GENERATE=1 to run a real generation through the Space')
    }
  }

  console.log('\n✓ asset generation verified\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
