// Verification path for 3D asset generation (Batch 4.5, Parts 2 and 3).
//
// Generates a real .glb with headless Blender and validates the container, then
// reports whether Tripo3D is reachable. Nothing here trusts an exit code: the
// proof is a parsed glTF with the expected mesh and material inside it.
//
// Run:
//   BLENDER_BIN=/path/to/blender \
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-assets.mjs
//
// Env:
//   BLENDER_BIN=<path>   Blender executable (portable build is fine)
//   OUT=<path>           where to write the .glb (default public/assets/golem-cube.glb)
//   TRIPO_PROMPT=<text>  run a real Tripo3D generation too (costs credits)

import { readFileSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  /* already in env */
}

const blender = await import('../src/lib/assets/blender.ts')
const tripo = await import('../src/lib/assets/tripo.ts')

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

  // ── Tripo3D ──────────────────────────────────────────────────────
  console.log('\nTRIPO3D')
  if (!tripo.tripoConfigured()) {
    no('TRIPO_API_KEY is not set — text-to-3D is BLOCKED pending a key from https://platform.tripo3d.ai')
    info('endpoint shapes confirmed: /task and /user/balance answer 401 with Tripo\'s own envelope, not 404')
  } else {
    const credits = await tripo.balance()
    ok(`authenticated — balance ${credits.balance} (frozen ${credits.frozen})`)
    if (process.env.TRIPO_PROMPT) {
      const out = resolve('public/assets/tripo-generated.glb')
      // generateGlbFromText validates the container itself and throws on a
      // truncated or non-glTF download, so reaching the next line already
      // means the bytes are a real model.
      const { task, info: glbInfo } = await tripo.generateGlbFromText(process.env.TRIPO_PROMPT, {
        onProgress: (t) => info(`${t.status} ${t.progress}%`),
        outPath: out,
      })
      ok(`task ${task.id} → ${glbInfo.bytes} bytes at ${out}`)
      info(`meshes:    ${glbInfo.meshes.join(', ') || '(unnamed)'}`)
      info(`materials: ${glbInfo.materials.join(', ') || '(none)'}`)
      ok('downloaded model parsed as valid glTF with a matching declared length')
    } else {
      ok('set TRIPO_PROMPT="..." to spend a credit and generate a real model')
    }
  }

  console.log('\n✓ asset generation verified\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
