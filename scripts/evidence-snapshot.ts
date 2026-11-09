import { Sandbox } from "@vercel/sandbox";
import { readFile } from "node:fs/promises";

const timeoutMs = 15 * 60_000;
// The legacy `runtime: "node24"` image is Amazon Linux and has no apt-get.
// universal is Ubuntu, with Node 24, so tesseract-ocr-spa and poppler install.
const sandbox = await Sandbox.create({
  image: "vercel/sandbox/universal",
  // Only the explicit snapshot below is kept; a failed build leaves nothing.
  persistent: false,
  timeout: timeoutMs,
  networkPolicy: "allow-all",
  resources: { vcpus: 2 },
  tags: { purpose: "evidence-harness-snapshot" },
});
let snapshotted = false;

async function run(command: string, args: string[], sudo = false, env?: Record<string, string>): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: command,
    args,
    sudo,
    env,
    timeoutMs: 10 * 60_000,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (result.exitCode !== 0) {
    const output = [await result.stdout(), await result.stderr()].filter(Boolean).join("\n").slice(-5000);
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
}

try {
  const [packageJson, harness, instructionHarness, compute] = await Promise.all([
    readFile("sandbox/harness/package.json", "utf8"),
    readFile("sandbox/harness/agent.ts", "utf8"),
    readFile("sandbox/harness/instruction-agent.ts", "utf8"),
    readFile("sandbox/harness/compute.ts", "utf8"),
  ]);
  await run("bash", ["-lc", "mkdir -p /opt/evidence-harness && chown -R \"$(id -un):$(id -gn)\" /opt/evidence-harness"], true);
  await sandbox.writeFiles([
    { path: "/opt/evidence-harness/package.json", content: packageJson },
    { path: "/opt/evidence-harness/agent.ts", content: harness },
    { path: "/opt/evidence-harness/instruction-agent.ts", content: instructionHarness },
    { path: "/opt/evidence-harness/compute.ts", content: compute },
  ]);
  await run("apt-get", ["update"], true, { DEBIAN_FRONTEND: "noninteractive" });
  await run("apt-get", ["install", "-y", "python3", "python3-pip", "tesseract-ocr", "tesseract-ocr-spa", "poppler-utils", "imagemagick"], true, { DEBIAN_FRONTEND: "noninteractive" });
  await run("python3", ["-m", "pip", "install", "--break-system-packages", "pymupdf"], true);
  await run("npm", ["install", "--prefix", "/opt/evidence-harness", "--omit=dev"]);
  await run("bash", ["-lc", "command -v pdftotext >/dev/null && command -v pdftoppm >/dev/null && command -v convert >/dev/null && tesseract --list-langs 2>&1 | grep -qx spa && python3 -c 'import fitz' && test -f /opt/evidence-harness/node_modules/tsx/dist/loader.mjs"]);
  // Production pins this id. Expiration 0 keeps it until that variable is updated and the old id is retired on purpose.
  const snapshot = await sandbox.snapshot({ expiration: 0 });
  snapshotted = true;
  console.log("Evidence snapshot: " + snapshot.snapshotId);
  console.log("Set EVIDENCE_SANDBOX_SNAPSHOT_ID to this value.");
  console.log("Shared instruction reuses this snapshot and uploads its current harness from the application deployment.");
} finally {
  if (!snapshotted) await sandbox.stop();
}
