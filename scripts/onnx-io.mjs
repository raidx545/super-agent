// ============================================================
// Standalone ONNX I/O inspector — walks the protobuf wire format
// directly (no onnxruntime, no WASM). Extracts graph inputs/outputs
// with element types and shapes, plus opset + a node-op histogram.
// This is how we learn the recognition head's class count (C in
// [1, T, C]) which dictates the PaddleOCR character dictionary.
// ============================================================
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(__dirname, "..", "public", "models");

const ELEM_TYPE = {
  0: "UNDEFINED", 1: "float32", 2: "uint8", 3: "int8", 4: "uint16",
  5: "int16", 6: "int32", 7: "int64", 8: "string", 9: "bool",
  10: "float16", 11: "float64", 12: "uint32", 13: "uint64",
};

// Minimal protobuf reader over a Uint8Array.
class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.b = buf; this.p = start; this.end = end;
  }
  eof() { return this.p >= this.end; }
  varint() {
    let shift = 0, result = 0n;
    for (;;) {
      const byte = this.b[this.p++];
      result |= BigInt(byte & 0x7f) << BigInt(shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }
  tag() {
    const v = Number(this.varint());
    return { field: v >>> 3, wire: v & 0x7 };
  }
  // returns a sub-Reader for a length-delimited field
  bytes() {
    const len = Number(this.varint());
    const r = new Reader(this.b, this.p, this.p + len);
    this.p += len;
    return r;
  }
  string() {
    const len = Number(this.varint());
    const s = Buffer.from(this.b.subarray(this.p, this.p + len)).toString("utf8");
    this.p += len;
    return s;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) { const len = Number(this.varint()); this.p += len; }
    else if (wire === 5) this.p += 4;
    else throw new Error(`bad wire ${wire}`);
  }
}

// TensorShapeProto.Dimension: dim_value(1 varint) | dim_param(2 string)
function parseDim(r) {
  let out = "?";
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) out = Number(r.varint());
    else if (field === 2 && wire === 2) out = r.string();
    else r.skip(wire);
  }
  return out;
}
// TensorShapeProto: dim(1 repeated)
function parseShape(r) {
  const dims = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) dims.push(parseDim(r.bytes()));
    else r.skip(wire);
  }
  return dims;
}
// TypeProto.Tensor: elem_type(1 varint), shape(2)
function parseTensorType(r) {
  let elem = 0, shape = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) elem = Number(r.varint());
    else if (field === 2 && wire === 2) shape = parseShape(r.bytes());
    else r.skip(wire);
  }
  return { elem, shape };
}
// TypeProto: tensor_type(1)
function parseType(r) {
  let t = { elem: 0, shape: [] };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) t = parseTensorType(r.bytes());
    else r.skip(wire);
  }
  return t;
}
// ValueInfoProto: name(1), type(2)
function parseValueInfo(r) {
  let name = "", type = { elem: 0, shape: [] };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) name = r.string();
    else if (field === 2 && wire === 2) type = parseType(r.bytes());
    else r.skip(wire);
  }
  return { name, ...type };
}
// NodeProto: op_type(4)
function parseNodeOp(r) {
  let op = "";
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 4 && wire === 2) op = r.string();
    else r.skip(wire);
  }
  return op;
}
// GraphProto: node(1), input(11), output(12)
function parseGraph(r) {
  const inputs = [], outputs = [], ops = {};
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) { const op = parseNodeOp(r.bytes()); ops[op] = (ops[op] || 0) + 1; }
    else if (field === 11 && wire === 2) inputs.push(parseValueInfo(r.bytes()));
    else if (field === 12 && wire === 2) outputs.push(parseValueInfo(r.bytes()));
    else r.skip(wire);
  }
  return { inputs, outputs, ops };
}
// OperatorSetIdProto: domain(1), version(2)
function parseOpset(r) {
  let domain = "", version = 0;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) domain = r.string();
    else if (field === 2 && wire === 0) version = Number(r.varint());
    else r.skip(wire);
  }
  return { domain: domain || "ai.onnx", version };
}
// ModelProto: ir_version(1), opset_import(8 repeated), graph(7)
function parseModel(buf) {
  const r = new Reader(buf);
  let ir = 0, graph = null; const opsets = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) ir = Number(r.varint());
    else if (field === 7 && wire === 2) graph = parseGraph(r.bytes());
    else if (field === 8 && wire === 2) opsets.push(parseOpset(r.bytes()));
    else r.skip(wire);
  }
  return { ir, opsets, graph };
}

function fmt(vi) {
  return `${vi.name}: ${ELEM_TYPE[vi.elem] || vi.elem}[${vi.shape.join(", ")}]`;
}

for (const file of ["ppocr-det-v3.onnx", "ppocr-rec-en.onnx", "ppocr-rec-hi.onnx"]) {
  const buf = new Uint8Array(readFileSync(join(modelsDir, file)));
  const m = parseModel(buf);
  console.log(`\n=== ${file} (${(buf.length / 1e6).toFixed(2)} MB) ===`);
  console.log(`  ir_version: ${m.ir}  opsets: ${m.opsets.map((o) => `${o.domain}@${o.version}`).join(", ")}`);
  console.log(`  INPUTS:`);
  for (const i of m.graph.inputs) console.log(`    ${fmt(i)}`);
  console.log(`  OUTPUTS:`);
  for (const o of m.graph.outputs) console.log(`    ${fmt(o)}`);
  const topOps = Object.entries(m.graph.ops).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`  op histogram (top): ${topOps.map(([k, v]) => `${k}×${v}`).join(", ")}`);
}
