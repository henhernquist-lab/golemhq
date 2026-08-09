// Install Blender persistently on the host that runs builder tasks.
//
// Deliberately routed through runHeadless — the same exec path runBuilderTask
// and detectClis use — rather than child_process. The point of that path is
// that it lands on whichever host actually executes tasks (node-pty in the
// Codespace, the Fly Sprite on Vercel) without the caller branching. An
// installer that shelled out locally would install Blender on whatever machine
// happened to run the script, which is not necessarily the one that needs it.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/install-blender.mjs
//
// Env:
//   BLENDER_VERSION=5.2.0   which release (must be a real LTS tarball)
//   BLENDER_SHA256=<hex>    expected checksum of the linux-x64 tarball
//   FORCE=1                 reinstall even if already present
//   HOST=sprite             install on the Fly Sprite instead of this machine


import './load-env.mjs'

// backend() picks the Sprite when VERCEL is set — that is the whole selector,
// and it is read at call time. Running this from the Codespace would otherwise
// always install locally, leaving production without Blender no matter how
// many times the installer succeeded.
if (process.env.HOST === 'sprite') process.env.VERCEL = '1'

const { runHeadless, backend } = await import('../src/lib/terminal/headless-run.ts')

const VERSION = process.env.BLENDER_VERSION ?? '5.2.0'
const SERIES = VERSION.split('.').slice(0, 2).join('.')
const TARBALL = `blender-${VERSION}-linux-x64.tar.xz`
const URL = `https://download.blender.org/release/Blender${SERIES}/${TARBALL}`
const SHA256 = process.env.BLENDER_SHA256 ?? '96f6c181a30f4950607839dc84d42a354b250d8a0231b098b59b7bc69c351c48'

// $HOME/.local is where this host's other user-installed tooling already lives
// (npm's global prefix points at it, hermes and node resolve out of its bin),
// so Blender goes in the same class of location rather than a new one. The
// versioned directory plus a stable `blender` symlink means an upgrade is a
// symlink flip and BLENDER_BIN never has to change.
const PREFIX = '$HOME/.local/opt'
const VERSIONED = `${PREFIX}/blender-${VERSION}`
const STABLE = `${PREFIX}/blender`
const BIN = `${STABLE}/blender`

// The download goes to /tmp on purpose: that is a separate, much larger device
// here, and staging 367MB on the persistent volume alongside the ~1GB
// extraction would need double the headroom the volume actually has.
const STAGE = '/tmp/blender-download'

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

const SCRIPT = `
set -e
if [ -x "${BIN}" ] && [ -z "\${FORCE_REINSTALL}" ]; then
  echo "ALREADY_INSTALLED"
  "${BIN}" --version | head -1
  exit 0
fi

mkdir -p "${STAGE}" "${PREFIX}"
cd "${STAGE}"

if [ ! -f "${TARBALL}" ]; then
  echo "DOWNLOADING"
  curl -fsSL -o "${TARBALL}.part" "${URL}"
  mv "${TARBALL}.part" "${TARBALL}"
fi
echo "DOWNLOADED $(stat -c %s "${TARBALL}") bytes"

echo "VERIFYING"
echo "${SHA256}  ${TARBALL}" | sha256sum -c -

echo "EXTRACTING"
rm -rf "${VERSIONED}"
mkdir -p "${VERSIONED}"
tar -xf "${TARBALL}" -C "${VERSIONED}" --strip-components=1

ln -sfn "${VERSIONED}" "${STABLE}"
mkdir -p "$HOME/.local/bin"
ln -sfn "${BIN}" "$HOME/.local/bin/blender"

# Reclaim the staged tarball; the extracted tree is the artifact worth keeping.
rm -f "${STAGE}/${TARBALL}"

echo "INSTALLED_AT $(readlink -f "${BIN}")"
"${BIN}" --version | head -1
`.trim()

try {
  console.log(`\nHOST      backend = ${backend().kind}`)
  console.log(`RELEASE   ${VERSION} (LTS)  ${URL}`)
  console.log(`TARGET    ${VERSIONED}  (stable symlink: ${STABLE})\n`)

  console.log('INSTALL (this downloads ~367MB and may take a few minutes)')
  const run = await runHeadless(process.env.FORCE === '1' ? `FORCE_REINSTALL=1 bash -c ${b64(SCRIPT)}` : `bash -c ${b64(SCRIPT)}`, {
    timeoutMs: 20 * 60 * 1000,
    runId: `blender-install-${Date.now()}`,
  })

  if (run.failure) throw new Error(run.failure)
  if (run.exitCode !== 0) throw new Error(`installer exited ${run.exitCode}\n${run.output.slice(-2000)}`)

  for (const line of run.output.split('\n')) {
    const t = line.trim()
    if (/^(ALREADY_INSTALLED|DOWNLOADING|DOWNLOADED|VERIFYING|EXTRACTING|INSTALLED_AT)/.test(t)) info(t)
    if (/^blender-.*: OK$/.test(t)) ok(`checksum verified: ${t}`)
    if (/^Blender \d/.test(t)) ok(t)
  }

  console.log('\nNEXT')
  info(`set BLENDER_BIN=$HOME/.local/opt/blender/blender in .env.local`)
  console.log('')
} catch (err) {
  console.error('\n✗ INSTALL FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)

function b64(s) {
  return `"$(echo ${Buffer.from(s, 'utf8').toString('base64')} | base64 -d)"`
}
