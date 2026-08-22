// Introspect the bundled PP-OCR ONNX models: input/output names + shapes.
// onnxruntime-web runs on WASM in Node (no native build needed).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(__dirname, "..", "public", "models");

const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;

async function inspect(file, inputShapeCandidates) {
  const path = join(modelsDir, file);
  const bytes = readFileSync(path);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
  });
  console.log(`\n=== ${file} ===`);
  console.log("inputNames :", session.inputNames);
  console.log("outputNames:", session.outputNames);

  const inName = session.inputNames[0];
  for (const shape of inputShapeCandidates) {
    try {
      const [n, c, h, w] = shape;
      const data = new Float32Array(n * c * h * w);
      const feeds = { [inName]: new ort.Tensor("float32", data, shape) };
      const out = await session.run(feeds);
      for (const [k, v] of Object.entries(out)) {
        console.log(`  input ${JSON.stringify(shape)} -> output "${k}" dims=${JSON.stringify(v.dims)}`);
      }
      break; // first shape that runs is enough
    } catch (e) {
      console.log(`  input ${JSON.stringify(shape)} FAILED: ${String(e).split("\n")[0]}`);
    }
  }
}

await inspect("ppocr-det-v3.onnx", [[1, 3, 640, 640], [1, 3, 960, 960]]);
await inspect("ppocr-rec-en.onnx", [[1, 3, 48, 320], [1, 3, 32, 320], [1, 3, 48, 100]]);
await inspect("ppocr-rec-hi.onnx", [[1, 3, 48, 320], [1, 3, 32, 320]]);
