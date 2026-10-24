/** Runtime contracts, independent of DSH patch/RC strings. No runtime snapshots. */
import { isDeepStrictEqual } from 'node:util'

export class RuntimeCompatibilityError extends Error {
  constructor(code) { super(code); this.name = 'RuntimeCompatibilityError'; this.code = code }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const incompatible = () => { throw new RuntimeCompatibilityError('mcp-config-contract-changed') }

function shape(schema, value) {
  if (schema?.type !== 'union') return schema
  // The native MCP union is discriminated by transport. Do not guess how a
  // future lazy/transform/intersection schema interprets security settings.
  if (!Array.isArray(schema.list)) incompatible()
  const branches = schema.list.filter(branch => branch.type === 'object' && branch.dict?.transport?.type === 'const' && branch.dict.transport.value === value?.transport)
  if (branches.length !== 1) incompatible()
  return branches[0]
}
function declared(schema, value, depth = 0) {
  schema = shape(schema, value)
  if (!schema || depth > 12) incompatible()
  if (schema.type === 'object') {
    if (!record(value) || !record(schema.dict)) incompatible()
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.dict, key)) incompatible()
      declared(schema.dict[key], item, depth + 1)
    }
  } else if (schema.type === 'dict') {
    if (!record(value)) incompatible()
    for (const item of Object.values(value)) declared(schema.inner, item, depth + 1)
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) incompatible()
    for (const item of value) declared(schema.inner, item, depth + 1)
  } else if (!['string', 'number', 'boolean', 'const'].includes(schema.type)) incompatible()
}
function preserved(schema, input, output) {
  schema = shape(schema, input)
  if (schema.type === 'object' && record(output)) {
    // Native defaults may grow; every supplied setting must remain effective.
    return Object.keys(input).every(key => Object.hasOwn(output, key) && preserved(schema.dict[key], input[key], output[key]))
  }
  // Opaque env/header maps must not gain ambient credentials. Arrays preserve order.
  return isDeepStrictEqual(input, output)
}

/** Fail before spawning/network I/O if native Config silently stops recognizing a field. */
export function prepareNativeMcp(module, config) {
  const plugin = module?.default ?? module
  const Config = plugin?.Config ?? module?.Config
  if (!plugin || (typeof plugin !== 'function' && typeof plugin.apply !== 'function') || typeof Config !== 'function') {
    throw new RuntimeCompatibilityError('mcp-client-api-unsupported')
  }
  // Schemastery preserves unknown fields, even nested fields. Successful
  // validation/round-trip equality alone therefore cannot establish support.
  declared(Config, config)
  let prepared
  try { prepared = Config(structuredClone(config)) }
  catch { throw new RuntimeCompatibilityError('mcp-config-rejected') }
  if (!preserved(Config, config, prepared)) incompatible()
  return { plugin, config: prepared }
}

export function assertSkillControl(control) {
  if (typeof control?.invalidate !== 'function' || typeof control?.signal?.aborted !== 'boolean' || typeof control.signal.addEventListener !== 'function') {
    throw new RuntimeCompatibilityError('skills-provider-control-unsupported')
  }
}
