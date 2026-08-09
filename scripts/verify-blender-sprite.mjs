// Prove Blender works on the Fly Sprite — the host production actually uses.
//
// Separate from verify-assets.mjs on purpose. That script calls
// src/lib/assets/blender.ts, which spawns Blender with child_process.execFile,
// so it can only ever test the machine the script runs on. Running it in the
// Codespace proves the Codespace. It says nothing about production.
//
// So everything here happens ON the Sprite: the scene script is delivered
// there, Blender runs there, and the .glb is validated there — parsing the
// binary header rather than trusting an exit code. Only the verdict comes back.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-blender-sprite.mjs
//
// Env:
//   TIMEOUT_MS=<n>   override the run cap (default 300000)

import './load-env.mjs'

process.env.VERCEL = '1' // select the Sprite backend, exactly as Vercel does

const { runHeadless, backend, base64Arg } = await import('../src/lib/terminal/headless-run.ts')

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300_000)
const BLENDER = '$HOME/.local/opt/blender/blender'
const WORK = '/tmp/golem-blender-verify'

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

// A cube with a real PBR material — mirrors verify-assets.mjs so the two hosts
// are compared on identical work.
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

// Validates the container the way inspectGlb does: magic, version, and the
// header's declared length against the real byte count (which is what catches a
// truncated write), then the mesh and material names out of the JSON chunk.
const VALIDATE_SCRIPT = `
import json, struct, sys
path = sys.argv[1]
data = open(path, 'rb').read()
magic, version, length = struct.unpack_from('<4sII', data, 0)
print('GLB_MAGIC', magic.decode('ascii', 'replace'))
print('GLB_VERSION', version)
print('GLB_DECLARED_LENGTH', length)
print('GLB_ACTUAL_BYTES', len(data))
print('GLB_LENGTH_MATCHES', length == len(data))
chunk_len, chunk_type = struct.unpack_from('<I4s', data, 12)
gltf = json.loads(data[20:20 + chunk_len].decode('utf-8'))
print('GLB_MESHES', ','.join(m.get('name', '?') for m in gltf.get('meshes', [])))
print('GLB_MATERIALS', ','.join(m.get('name', '?') for m in gltf.get('materials', [])))
`.trim()

const SCRIPT = `
set -e
rm -rf ${WORK}; mkdir -p ${WORK}
printf %s ${Buffer.from(CUBE_SCRIPT, 'utf8').toString('base64')} | base64 -d > ${WORK}/cube.py
printf %s ${Buffer.from(VALIDATE_SCRIPT, 'utf8').toString('base64')} | base64 -d > ${WORK}/validate.py

echo "BLENDER_BIN $(readlink -f ${BLENDER})"
${BLENDER} --version | head -1

# --background needs no display; the export path never touches a GPU.
${BLENDER} --background --python ${WORK}/cube.py -- ${WORK}/cube.glb > ${WORK}/blender.log 2>&1 || {
  echo "BLENDER_FAILED"; tail -20 ${WORK}/blender.log; exit 1;
}
echo "GLB_ON_SPRITE $(stat -c %s ${WORK}/cube.glb) bytes at ${WORK}/cube.glb"
python3 ${WORK}/validate.py ${WORK}/cube.glb
`.trim()

try {
  console.log(`\nHOST      backend = ${backend().kind}  sprite = ${process.env.SPRITE_NAME ?? 'enry-terminal'}`)

  console.log('\nBLENDER ON THE SPRITE')
  const run = await runHeadless(`bash -c ${base64Arg(SCRIPT)}`, {
    timeoutMs: TIMEOUT_MS,
    runId: `blender-sprite-${Date.now()}`,
  })

  if (run.failure) throw new Error(run.failure)
  if (run.timedOut) throw new Error(`timed out after ${TIMEOUT_MS}ms`)
  if (run.exitCode !== 0) throw new Error(`exit ${run.exitCode}\n${run.output.slice(-2000)}`)

  const fields = new Map()
  for (const raw of run.output.split('\n')) {
    const t = raw.trim()
    const m = /^([A-Z_]+) (.*)$/.exec(t)
    if (m) fields.set(m[1], m[2])
    if (/^Blender \d/.test(t)) ok(t)
    if (/^BLENDER_BIN |^GLB_ON_SPRITE /.test(t)) info(t)
  }

  if (fields.get('GLB_MAGIC') !== 'glTF') throw new Error(`bad magic: ${fields.get('GLB_MAGIC')}`)
  ok(`glTF magic present, container version ${fields.get('GLB_VERSION')}`)

  if (fields.get('GLB_LENGTH_MATCHES') !== 'True') {
    throw new Error(
      `truncated .glb — header declares ${fields.get('GLB_DECLARED_LENGTH')} bytes, file is ${fields.get('GLB_ACTUAL_BYTES')}`,
    )
  }
  ok(`header length matches the file exactly (${fields.get('GLB_ACTUAL_BYTES')} bytes)`)

  // The material is the assertion, as in verify-assets.mjs: glTF carries mesh
  // DATA names, so the object rename to "GolemCube" never reaches the file and
  // a mesh named "Cube" here is correct, not a regression.
  if (fields.get('GLB_MATERIALS') !== 'GolemGreen') throw new Error(`unexpected materials: ${fields.get('GLB_MATERIALS')}`)
  info(`meshes:    ${fields.get('GLB_MESHES')}`)
  ok(`material "${fields.get('GLB_MATERIALS')}" survived the export`)

  console.log('\n✓ Blender renders and exports a valid .glb on the Sprite\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  process.exit(process.exitCode ?? 0)
}
